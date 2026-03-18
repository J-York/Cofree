use crate::commands::http::{
    apply_protocol_headers, build_protocol_endpoints, build_reqwest_client_with_proxy,
};
use crate::domain::ProxySettings;
use serde_json::Value;

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

#[tauri::command]
pub async fn fetch_litellm_models(
    base_url: String,
    api_key: String,
    protocol: String,
    proxy: Option<ProxySettings>,
) -> Result<Vec<String>, String> {
    let endpoints = build_protocol_endpoints(base_url.trim(), &protocol, true);
    if endpoints.is_empty() {
        return Err("LiteLLM Base URL 不能为空".to_string());
    }
    let client = build_reqwest_client_with_proxy(proxy, Some(120))?;
    let mut errors = Vec::new();
    for endpoint in endpoints {
        match fetch_models_from_endpoint(&client, &endpoint, &protocol, &api_key).await {
            Ok(models) => return Ok(models),
            Err(error) => errors.push(error),
        }
    }
    Err(format!("拉取模型失败: {}", errors.join(" | ")))
}
