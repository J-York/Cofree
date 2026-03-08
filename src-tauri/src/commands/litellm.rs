use crate::commands::http::{
    apply_protocol_headers, build_protocol_endpoints, build_reqwest_client_with_proxy,
    normalize_base_url, normalize_protocol,
};
use crate::domain::{LiteLLMHttpResponse, ProxySettings, StreamChunkEvent};
use futures_util::StreamExt;
use serde_json::Value;
use std::collections::HashMap;
use tauri::Emitter;

fn extract_error_message(payload: &Value) -> Option<String> {
    if let Some(message) = payload.get("message").and_then(Value::as_str) {
        return Some(message.to_string());
    }
    if let Some(error) = payload.get("error") {
        if let Some(message) = error.as_str() {
            return Some(message.to_string());
        }
        if let Some(message) = error.get("message").and_then(Value::as_str) {
            return Some(message.to_string());
        }
    }
    None
}

fn extract_model_ids(payload: &Value) -> Vec<String> {
    let mut model_ids: Vec<String> = Vec::new();
    let entries: Vec<&Value> = if let Some(array) = payload.as_array() {
        array.iter().collect()
    } else if let Some(array) = payload.get("data").and_then(Value::as_array) {
        array.iter().collect()
    } else {
        Vec::new()
    };
    for entry in entries {
        if let Some(id) = entry.as_str() {
            let trimmed = id.trim();
            if !trimmed.is_empty() {
                model_ids.push(trimmed.to_string());
            }
            continue;
        }
        if let Some(object) = entry.as_object() {
            for key in ["id", "model_name", "model", "name"] {
                if let Some(id) = object.get(key).and_then(Value::as_str) {
                    let trimmed = id.trim();
                    if !trimmed.is_empty() {
                        model_ids.push(trimmed.to_string());
                    }
                    break;
                }
            }
        }
    }
    model_ids.sort();
    model_ids.dedup();
    model_ids
}

async fn fetch_models_from_endpoint(
    client: &reqwest::Client,
    endpoint: &str,
    protocol: &str,
    api_key: &str,
) -> Result<Vec<String>, String> {
    let response =
        apply_protocol_headers(client.get(endpoint), protocol, api_key, "application/json")
            .send()
            .await
            .map_err(|e| format!("{} 请求失败: {}", endpoint, e))?;
    let status = response.status();
    let payload = response.json::<Value>().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let detail = extract_error_message(&payload).unwrap_or_default();
        if detail.is_empty() {
            return Err(format!("{} 返回 HTTP {}", endpoint, status.as_u16()));
        }
        return Err(format!(
            "{} 返回 HTTP {}: {}",
            endpoint,
            status.as_u16(),
            detail
        ));
    }
    let model_ids = extract_model_ids(&payload);
    if model_ids.is_empty() {
        return Err(format!("{} 未返回可用模型", endpoint));
    }
    Ok(model_ids)
}

async fn post_chat_completion_to_endpoint(
    client: &reqwest::Client,
    endpoint: &str,
    protocol: &str,
    api_key: &str,
    body: &Value,
) -> Result<LiteLLMHttpResponse, String> {
    let response = apply_protocol_headers(
        client.post(endpoint).json(body),
        protocol,
        api_key,
        "application/json",
    )
    .send()
    .await
    .map_err(|e| format!("{} 请求失败: {}", endpoint, e))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|e| format!("{} 读取响应失败: {}", endpoint, e))?;
    Ok(LiteLLMHttpResponse {
        status,
        body,
        endpoint: endpoint.to_string(),
    })
}

fn emit_stream_chunk_event(
    app: &tauri::AppHandle,
    request_id: &str,
    content: &str,
    done: bool,
    finish_reason: Option<String>,
) {
    let _ = app.emit(
        "llm-stream-chunk",
        StreamChunkEvent {
            request_id: request_id.to_string(),
            content: content.to_string(),
            done,
            finish_reason,
        },
    );
}

fn ensure_tool_call_entry(tool_calls_json: &mut Vec<Value>, index: usize) -> &mut Value {
    while tool_calls_json.len() <= index {
        tool_calls_json.push(serde_json::json!({
            "id": "",
            "type": "function",
            "function": { "name": "", "arguments": "" }
        }));
    }
    &mut tool_calls_json[index]
}

fn append_tool_call_delta(
    entry: &mut Value,
    id: Option<&str>,
    name: Option<&str>,
    args_delta: Option<&str>,
) {
    if let Some(id) = id {
        entry["id"] = Value::String(id.to_string());
    }
    if let Some(name) = name {
        entry["function"]["name"] = Value::String(name.to_string());
    }
    if let Some(args_delta) = args_delta {
        let existing = entry["function"]["arguments"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        entry["function"]["arguments"] = Value::String(format!("{}{}", existing, args_delta));
    }
}

fn set_tool_call_arguments(entry: &mut Value, arguments: &str) {
    entry["function"]["arguments"] = Value::String(arguments.to_string());
}

fn retain_valid_tool_calls(tool_calls_json: &mut Vec<Value>) {
    tool_calls_json.retain(|entry| {
        let function = entry.get("function");
        let name_ok = function
            .and_then(|f| f.get("name"))
            .and_then(Value::as_str)
            .map(|name| !name.trim().is_empty())
            .unwrap_or(false);
        let args_ok = function
            .and_then(|f| f.get("arguments"))
            .and_then(Value::as_str)
            .map(|args| !args.trim().is_empty())
            .unwrap_or(false);
        name_ok && args_ok
    });
}

fn build_synthetic_stream_body(
    full_content: String,
    finish_reason: Option<String>,
    mut tool_calls_json: Vec<Value>,
    usage_info: Value,
) -> String {
    let mut message = serde_json::json!({ "role": "assistant", "content": full_content });
    retain_valid_tool_calls(&mut tool_calls_json);
    if !tool_calls_json.is_empty() {
        message["tool_calls"] = Value::Array(tool_calls_json);
    }
    let synthetic_response = serde_json::json!({
        "choices": [{ "message": message, "finish_reason": finish_reason.unwrap_or_else(|| "stop".to_string()) }],
        "usage": usage_info,
    });
    serde_json::to_string(&synthetic_response).unwrap_or_default()
}

fn zero_usage() -> Value {
    serde_json::json!({ "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 })
}

fn anthropic_usage_to_openai(usage: &Value) -> Value {
    let input_tokens = usage
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output_tokens = usage
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    serde_json::json!({
        "prompt_tokens": input_tokens,
        "completion_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
    })
}

struct AnthropicStreamState {
    full_content: String,
    finish_reason: Option<String>,
    tool_calls_json: Vec<Value>,
    usage_info: Value,
}

impl AnthropicStreamState {
    fn new() -> Self {
        Self {
            full_content: String::new(),
            finish_reason: None,
            tool_calls_json: Vec::new(),
            usage_info: zero_usage(),
        }
    }
}

fn resolve_anthropic_stream_event_name<'a>(current_event: &'a str, parsed: &'a Value) -> &'a str {
    if !current_event.trim().is_empty() {
        return current_event;
    }
    parsed
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn serialize_tool_call_arguments(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text.to_string()),
        _ => serde_json::to_string(value).ok(),
    }
    .filter(|text| !text.trim().is_empty())
}

fn populate_anthropic_tool_call_from_block(
    tool_calls_json: &mut Vec<Value>,
    block_index: usize,
    block: &Value,
) {
    if block.get("type").and_then(Value::as_str) != Some("tool_use") {
        return;
    }

    let entry = ensure_tool_call_entry(tool_calls_json, block_index);
    append_tool_call_delta(
        entry,
        block.get("id").and_then(Value::as_str),
        block.get("name").and_then(Value::as_str),
        None,
    );

    if let Some(arguments) = block.get("input").and_then(serialize_tool_call_arguments) {
        set_tool_call_arguments(entry, &arguments);
    }
}

fn apply_anthropic_stream_event(
    state: &mut AnthropicStreamState,
    current_event: &str,
    parsed: &Value,
) -> Vec<String> {
    let event_name = resolve_anthropic_stream_event_name(current_event, parsed);
    let mut emitted_chunks: Vec<String> = Vec::new();

    match event_name {
        "message_start" => {
            if let Some(message) = parsed.get("message") {
                if let Some(usage) = message.get("usage") {
                    state.usage_info = anthropic_usage_to_openai(usage);
                }
                if let Some(content_blocks) = message.get("content").and_then(Value::as_array) {
                    for (block_index, block) in content_blocks.iter().enumerate() {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            state.full_content.push_str(text);
                            emitted_chunks.push(text.to_string());
                        }
                        populate_anthropic_tool_call_from_block(
                            &mut state.tool_calls_json,
                            block_index,
                            block,
                        );
                    }
                }
            }
        }
        "content_block_start" => {
            let block_index = parsed.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            if let Some(content_block) = parsed.get("content_block") {
                populate_anthropic_tool_call_from_block(
                    &mut state.tool_calls_json,
                    block_index,
                    content_block,
                );
            }
        }
        "content_block_delta" => {
            let block_index = parsed.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            if let Some(delta) = parsed.get("delta") {
                if let Some(text) = delta.get("text").and_then(Value::as_str) {
                    state.full_content.push_str(text);
                    emitted_chunks.push(text.to_string());
                }

                if delta.get("id").is_some()
                    || delta.get("name").is_some()
                    || delta.get("partial_json").is_some()
                    || delta.get("input").is_some()
                    || delta.get("arguments").is_some()
                {
                    let entry = ensure_tool_call_entry(&mut state.tool_calls_json, block_index);
                    append_tool_call_delta(
                        entry,
                        delta.get("id").and_then(Value::as_str),
                        delta.get("name").and_then(Value::as_str),
                        delta.get("partial_json").and_then(Value::as_str),
                    );
                    if let Some(arguments) = delta
                        .get("input")
                        .and_then(serialize_tool_call_arguments)
                        .or_else(|| delta.get("arguments").and_then(serialize_tool_call_arguments))
                    {
                        set_tool_call_arguments(entry, &arguments);
                    }
                }
            }
        }
        "content_block_stop" => {
            let block_index = parsed.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            if let Some(content_block) = parsed.get("content_block") {
                populate_anthropic_tool_call_from_block(
                    &mut state.tool_calls_json,
                    block_index,
                    content_block,
                );
            }
        }
        "message_delta" => {
            if let Some(delta) = parsed.get("delta") {
                if let Some(stop_reason) = delta.get("stop_reason").and_then(Value::as_str) {
                    state.finish_reason = Some(stop_reason.to_string());
                }
            }
            if let Some(stop_reason) = parsed.get("stop_reason").and_then(Value::as_str) {
                state.finish_reason = Some(stop_reason.to_string());
            }
            if let Some(usage) = parsed.get("usage") {
                state.usage_info = merge_anthropic_usage(&state.usage_info, usage);
            }
        }
        _ => {}
    }

    emitted_chunks
}

fn merge_anthropic_usage(existing: &Value, delta: &Value) -> Value {
    let prompt_tokens = delta
        .get("input_tokens")
        .and_then(Value::as_u64)
        .or_else(|| existing.get("prompt_tokens").and_then(Value::as_u64))
        .unwrap_or(0);
    let completion_tokens = delta
        .get("output_tokens")
        .and_then(Value::as_u64)
        .or_else(|| existing.get("completion_tokens").and_then(Value::as_u64))
        .unwrap_or(0);
    serde_json::json!({
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": prompt_tokens + completion_tokens,
    })
}

async fn parse_openai_chat_stream(
    app: &tauri::AppHandle,
    response: reqwest::Response,
    request_id: &str,
) -> Result<String, String> {
    let mut full_content = String::new();
    let mut finish_reason: Option<String> = None;
    let mut tool_calls_json: Vec<Value> = Vec::new();
    let mut usage_info: Option<Value> = None;
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("读取流数据失败: {}", e))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].trim().to_string();
            buffer = buffer[newline_pos + 1..].to_string();
            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            if line == "data: [DONE]" {
                emit_stream_chunk_event(app, request_id, "", true, finish_reason.clone());
                continue;
            }
            if let Some(data) = line.strip_prefix("data: ") {
                if let Ok(parsed) = serde_json::from_str::<Value>(data) {
                    if let Some(usage) = parsed.get("usage") {
                        if usage.is_object() && usage.get("prompt_tokens").is_some() {
                            usage_info = Some(usage.clone());
                        }
                    }
                    if let Some(choices) = parsed.get("choices").and_then(Value::as_array) {
                        for choice in choices {
                            if let Some(delta) = choice.get("delta") {
                                if let Some(content) = delta.get("content").and_then(Value::as_str)
                                {
                                    full_content.push_str(content);
                                    emit_stream_chunk_event(app, request_id, content, false, None);
                                }
                                if let Some(tc) = delta.get("tool_calls").and_then(Value::as_array)
                                {
                                    for tool_call_delta in tc {
                                        let tc_index = tool_call_delta
                                            .get("index")
                                            .and_then(Value::as_u64)
                                            .unwrap_or(0)
                                            as usize;
                                        let tc_entry =
                                            ensure_tool_call_entry(&mut tool_calls_json, tc_index);
                                        append_tool_call_delta(
                                            tc_entry,
                                            tool_call_delta.get("id").and_then(Value::as_str),
                                            tool_call_delta
                                                .get("function")
                                                .and_then(|func| func.get("name"))
                                                .and_then(Value::as_str),
                                            tool_call_delta
                                                .get("function")
                                                .and_then(|func| func.get("arguments"))
                                                .and_then(Value::as_str),
                                        );
                                    }
                                }
                            }
                            if let Some(fr) = choice.get("finish_reason").and_then(Value::as_str) {
                                finish_reason = Some(fr.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(build_synthetic_stream_body(
        full_content,
        finish_reason,
        tool_calls_json,
        usage_info.unwrap_or_else(zero_usage),
    ))
}

async fn parse_openai_responses_stream(
    app: &tauri::AppHandle,
    response: reqwest::Response,
    request_id: &str,
) -> Result<String, String> {
    let mut full_content = String::new();
    let mut finish_reason: Option<String> = None;
    let mut tool_calls_json: Vec<Value> = Vec::new();
    let mut call_index_by_key: HashMap<String, usize> = HashMap::new();
    let mut usage_info: Value = zero_usage();
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("读取流数据失败: {}", e))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].trim().to_string();
            buffer = buffer[newline_pos + 1..].to_string();
            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            if line == "data: [DONE]" {
                emit_stream_chunk_event(app, request_id, "", true, finish_reason.clone());
                continue;
            }
            if let Some(data) = line.strip_prefix("data: ") {
                if let Ok(parsed) = serde_json::from_str::<Value>(data) {
                    let event_type = parsed
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    match event_type {
                        "response.output_text.delta" => {
                            if let Some(delta) = parsed.get("delta").and_then(Value::as_str) {
                                full_content.push_str(delta);
                                emit_stream_chunk_event(app, request_id, delta, false, None);
                            }
                        }
                        "response.function_call_arguments.delta"
                        | "response.function_call_arguments.done" => {
                            let key = parsed
                                .get("item_id")
                                .and_then(Value::as_str)
                                .or_else(|| parsed.get("call_id").and_then(Value::as_str))
                                .or_else(|| parsed.get("id").and_then(Value::as_str))
                                .unwrap_or("call-0")
                                .to_string();
                            let entry_index = if let Some(existing) = call_index_by_key.get(&key) {
                                *existing
                            } else {
                                let index = tool_calls_json.len();
                                call_index_by_key.insert(key.clone(), index);
                                index
                            };
                            let entry = ensure_tool_call_entry(&mut tool_calls_json, entry_index);
                            append_tool_call_delta(
                                entry,
                                parsed
                                    .get("call_id")
                                    .and_then(Value::as_str)
                                    .or(Some(key.as_str())),
                                parsed.get("name").and_then(Value::as_str),
                                parsed.get("delta").and_then(Value::as_str),
                            );
                            if let Some(arguments) = parsed.get("arguments").and_then(Value::as_str)
                            {
                                set_tool_call_arguments(entry, arguments);
                            }
                        }
                        "response.output_item.added" | "response.output_item.done" => {
                            if let Some(item) = parsed.get("item") {
                                if item.get("type").and_then(Value::as_str) == Some("function_call")
                                {
                                    let key = item
                                        .get("call_id")
                                        .and_then(Value::as_str)
                                        .or_else(|| item.get("id").and_then(Value::as_str))
                                        .unwrap_or("call-0")
                                        .to_string();
                                    let entry_index =
                                        if let Some(existing) = call_index_by_key.get(&key) {
                                            *existing
                                        } else {
                                            let index = tool_calls_json.len();
                                            call_index_by_key.insert(key.clone(), index);
                                            index
                                        };
                                    let entry =
                                        ensure_tool_call_entry(&mut tool_calls_json, entry_index);
                                    append_tool_call_delta(
                                        entry,
                                        item.get("call_id")
                                            .and_then(Value::as_str)
                                            .or(Some(key.as_str())),
                                        item.get("name").and_then(Value::as_str),
                                        None,
                                    );
                                    if let Some(arguments) =
                                        item.get("arguments").and_then(Value::as_str)
                                    {
                                        set_tool_call_arguments(entry, arguments);
                                    }
                                }
                            }
                        }
                        "response.completed" => {
                            if let Some(response_obj) = parsed.get("response") {
                                if let Some(usage) = response_obj.get("usage") {
                                    let prompt_tokens = usage
                                        .get("input_tokens")
                                        .and_then(Value::as_u64)
                                        .unwrap_or(0);
                                    let completion_tokens = usage
                                        .get("output_tokens")
                                        .and_then(Value::as_u64)
                                        .unwrap_or(0);
                                    usage_info = serde_json::json!({
                                        "prompt_tokens": prompt_tokens,
                                        "completion_tokens": completion_tokens,
                                        "total_tokens": prompt_tokens + completion_tokens,
                                    });
                                }
                                finish_reason = response_obj
                                    .get("status")
                                    .and_then(Value::as_str)
                                    .map(|status| status.to_string());
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    Ok(build_synthetic_stream_body(
        full_content,
        finish_reason,
        tool_calls_json,
        usage_info,
    ))
}

async fn parse_anthropic_messages_stream(
    app: &tauri::AppHandle,
    response: reqwest::Response,
    request_id: &str,
) -> Result<String, String> {
    let mut current_event = String::new();
    let mut state = AnthropicStreamState::new();
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("读取流数据失败: {}", e))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(newline_pos) = buffer.find('\n') {
            let raw_line = buffer[..newline_pos].trim().to_string();
            buffer = buffer[newline_pos + 1..].to_string();

            if raw_line.is_empty() {
                current_event.clear();
                continue;
            }
            if raw_line.starts_with(':') {
                continue;
            }
            if let Some(event_name) = raw_line.strip_prefix("event: ") {
                current_event = event_name.to_string();
                continue;
            }
            if raw_line == "data: [DONE]" {
                emit_stream_chunk_event(app, request_id, "", true, state.finish_reason.clone());
                continue;
            }
            if let Some(data) = raw_line.strip_prefix("data: ") {
                if let Ok(parsed) = serde_json::from_str::<Value>(data) {
                    for chunk in apply_anthropic_stream_event(&mut state, &current_event, &parsed) {
                        emit_stream_chunk_event(app, request_id, &chunk, false, None);
                    }
                    if resolve_anthropic_stream_event_name(&current_event, &parsed) == "message_stop" {
                        emit_stream_chunk_event(
                            app,
                            request_id,
                            "",
                            true,
                            state.finish_reason.clone(),
                        );
                    }
                }
            }
        }
    }

    Ok(build_synthetic_stream_body(
        state.full_content,
        state.finish_reason,
        state.tool_calls_json,
        state.usage_info,
    ))
}

#[tauri::command]
pub async fn fetch_litellm_models(
    base_url: String,
    api_key: String,
    protocol: String,
    proxy: Option<ProxySettings>,
) -> Result<Vec<String>, String> {
    let normalized = normalize_base_url(&base_url);
    if normalized.is_empty() {
        return Err("LiteLLM Base URL 不能为空".to_string());
    }
    let client = build_reqwest_client_with_proxy(proxy, 120)?;
    let endpoints = build_protocol_endpoints(&normalized, &protocol, true);
    let mut errors = Vec::new();
    for endpoint in endpoints {
        match fetch_models_from_endpoint(&client, &endpoint, &protocol, &api_key).await {
            Ok(models) => return Ok(models),
            Err(error) => errors.push(error),
        }
    }
    Err(format!("拉取模型失败: {}", errors.join(" | ")))
}

#[tauri::command]
pub async fn post_litellm_chat_completions(
    base_url: String,
    api_key: String,
    protocol: String,
    body: Value,
    proxy: Option<ProxySettings>,
) -> Result<LiteLLMHttpResponse, String> {
    let normalized = normalize_base_url(&base_url);
    if normalized.is_empty() {
        return Err("LiteLLM Base URL 不能为空".to_string());
    }
    let client = build_reqwest_client_with_proxy(proxy, 120)?;
    let endpoints = build_protocol_endpoints(&normalized, &protocol, false);
    let mut errors = Vec::new();
    for (index, endpoint) in endpoints.iter().enumerate() {
        match post_chat_completion_to_endpoint(&client, endpoint, &protocol, &api_key, &body).await
        {
            Ok(response) => {
                // 可重试的服务端错误：404 (endpoint not found), 500 (server error), 502 (bad gateway), 503 (service unavailable), 504 (gateway timeout), 429 (rate limit)
                let is_retriable = matches!(response.status, 404 | 500 | 502 | 503 | 504 | 429);
                if is_retriable && index + 1 < endpoints.len() {
                    eprintln!(
                        "[LLM][Retry] endpoint={} status={} attempt={}/{}",
                        endpoint, response.status, index + 1, endpoints.len()
                    );
                    errors.push(format!("{} 返回 HTTP {}", endpoint, response.status));
                    continue;
                }
                return Ok(response);
            }
            Err(error) => errors.push(error),
        }
    }
    Err(format!(
        "请求 chat/completions 失败: {}",
        errors.join(" | ")
    ))
}

#[tauri::command]
pub async fn post_litellm_chat_completions_stream(
    app: tauri::AppHandle,
    base_url: String,
    api_key: String,
    protocol: String,
    body: Value,
    request_id: String,
    proxy: Option<ProxySettings>,
) -> Result<LiteLLMHttpResponse, String> {
    let normalized = normalize_base_url(&base_url);
    if normalized.is_empty() {
        return Err("LiteLLM Base URL 不能为空".to_string());
    }
    let client = build_reqwest_client_with_proxy(proxy, 300)?;
    let mut stream_body = body.clone();
    if let Some(obj) = stream_body.as_object_mut() {
        obj.insert("stream".to_string(), Value::Bool(true));
        if normalize_protocol(&protocol) == "openai-chat-completions" {
            obj.insert(
                "stream_options".to_string(),
                serde_json::json!({ "include_usage": true }),
            );
        }
    }
    let endpoints = build_protocol_endpoints(&normalized, &protocol, false);
    let mut errors = Vec::new();
    for (index, endpoint) in endpoints.iter().enumerate() {
        let response = match apply_protocol_headers(
            client.post(endpoint).json(&stream_body),
            &protocol,
            &api_key,
            "text/event-stream",
        )
        .send()
        .await
        {
            Ok(r) => r,
            Err(e) => {
                errors.push(format!("{} 请求失败: {}", endpoint, e));
                continue;
            }
        };
        let status = response.status().as_u16();
        // 可重试的服务端错误：404 (endpoint not found), 500 (server error), 502 (bad gateway), 503 (service unavailable), 504 (gateway timeout), 429 (rate limit)
        let is_retriable = matches!(status, 404 | 500 | 502 | 503 | 504 | 429);
        if is_retriable && index + 1 < endpoints.len() {
            eprintln!(
                "[LLM][Retry] endpoint={} status={} attempt={}/{} mode=stream",
                endpoint, status, index + 1, endpoints.len()
            );
            errors.push(format!("{} 返回 HTTP {}", endpoint, status));
            continue;
        }
        if !response.status().is_success() {
            let body_text = response.text().await.unwrap_or_default();
            return Ok(LiteLLMHttpResponse {
                status,
                body: body_text,
                endpoint: endpoint.to_string(),
            });
        }
        let synthetic_body = match normalize_protocol(&protocol) {
            "openai-responses" => parse_openai_responses_stream(&app, response, &request_id).await,
            "anthropic-messages" => {
                parse_anthropic_messages_stream(&app, response, &request_id).await
            }
            _ => parse_openai_chat_stream(&app, response, &request_id).await,
        };
        let synthetic_body = match synthetic_body {
            Ok(body) => body,
            Err(error) => {
                errors.push(format!("{} 流解析失败: {}", endpoint, error));
                continue;
            }
        };
        return Ok(LiteLLMHttpResponse {
            status,
            body: synthetic_body,
            endpoint: endpoint.to_string(),
        });
    }
    Err(format!(
        "请求 streaming chat/completions 失败: {}",
        errors.join(" | ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_payload_from_state(state: AnthropicStreamState) -> Value {
        serde_json::from_str(&build_synthetic_stream_body(
            state.full_content,
            state.finish_reason,
            state.tool_calls_json,
            state.usage_info,
        ))
        .expect("synthetic payload should be valid JSON")
    }

    #[test]
    fn reconstructs_tool_use_when_event_name_only_exists_in_payload_type() {
        let mut state = AnthropicStreamState::new();

        apply_anthropic_stream_event(
            &mut state,
            "",
            &serde_json::json!({
                "type": "message_start",
                "message": {
                    "usage": {
                        "input_tokens": 12,
                        "output_tokens": 0
                    }
                }
            }),
        );
        apply_anthropic_stream_event(
            &mut state,
            "",
            &serde_json::json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": {
                    "type": "tool_use",
                    "id": "toolu_123",
                    "name": "read_file",
                    "input": {
                        "relative_path": "src/App.tsx"
                    }
                }
            }),
        );
        apply_anthropic_stream_event(
            &mut state,
            "",
            &serde_json::json!({
                "type": "message_delta",
                "delta": {
                    "stop_reason": "tool_use"
                },
                "usage": {
                    "output_tokens": 7
                }
            }),
        );

        let payload = synthetic_payload_from_state(state);
        assert_eq!(
            payload["choices"][0]["message"]["tool_calls"],
            serde_json::json!([
                {
                    "id": "toolu_123",
                    "type": "function",
                    "function": {
                        "name": "read_file",
                        "arguments": "{\"relative_path\":\"src/App.tsx\"}"
                    }
                }
            ])
        );
        assert_eq!(payload["choices"][0]["message"]["content"], Value::String(String::new()));
        assert_eq!(payload["choices"][0]["finish_reason"], Value::String("tool_use".to_string()));
        assert_eq!(payload["usage"]["prompt_tokens"], Value::from(12));
        assert_eq!(payload["usage"]["completion_tokens"], Value::from(7));
    }

    #[test]
    fn reconstructs_tool_use_from_partial_json_without_delta_type() {
        let mut state = AnthropicStreamState::new();

        apply_anthropic_stream_event(
            &mut state,
            "content_block_start",
            &serde_json::json!({
                "index": 0,
                "content_block": {
                    "type": "tool_use",
                    "id": "toolu_456",
                    "name": "grep"
                }
            }),
        );
        apply_anthropic_stream_event(
            &mut state,
            "content_block_delta",
            &serde_json::json!({
                "index": 0,
                "delta": {
                    "partial_json": "{\"pattern\":\"tool_call\",\"path\":\"src\"}"
                }
            }),
        );
        apply_anthropic_stream_event(
            &mut state,
            "message_delta",
            &serde_json::json!({
                "delta": {
                    "stop_reason": "tool_use"
                }
            }),
        );

        let payload = synthetic_payload_from_state(state);
        assert_eq!(
            payload["choices"][0]["message"]["tool_calls"],
            serde_json::json!([
                {
                    "id": "toolu_456",
                    "type": "function",
                    "function": {
                        "name": "grep",
                        "arguments": "{\"pattern\":\"tool_call\",\"path\":\"src\"}"
                    }
                }
            ])
        );
        assert_eq!(payload["choices"][0]["message"]["content"], Value::String(String::new()));
    }
}
