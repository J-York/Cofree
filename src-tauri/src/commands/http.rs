use crate::config;
use crate::domain::ProxySettings;
use futures_util::future::{AbortHandle, Abortable};
use futures_util::StreamExt;
use reqwest::header::ACCEPT;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::ipc::Channel;

/// Event protocol for `perform_http_request_stream`. Sent from Rust → JS via
/// a typed `Channel`. The JS side reconstructs a streaming `Response` from this
/// sequence: exactly one `head`, zero-or-more `chunk`, then one `end` or `error`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum HttpStreamEvent {
    Head {
        status: u16,
        status_text: String,
        url: String,
        headers: Vec<(String, String)>,
    },
    Chunk {
        data: String,
    },
    End,
    Error {
        message: String,
    },
}

/// Splits an incoming byte stream at UTF-8 code-point boundaries so that each
/// emitted `String` is valid UTF-8. Carries any incomplete trailing byte
/// sequence into the next call. This matters because `bytes_stream()` chunks
/// are aligned to TCP/HTTP framing, not UTF-8 boundaries.
struct Utf8Splitter {
    carry: Vec<u8>,
}

impl Utf8Splitter {
    fn new() -> Self {
        Self { carry: Vec::new() }
    }

    fn push(&mut self, bytes: &[u8]) -> String {
        self.carry.extend_from_slice(bytes);
        let valid_up_to = match std::str::from_utf8(&self.carry) {
            Ok(_) => self.carry.len(),
            Err(e) => e.valid_up_to(),
        };
        if valid_up_to == 0 {
            return String::new();
        }
        let drained: Vec<u8> = self.carry.drain(..valid_up_to).collect();
        String::from_utf8(drained).unwrap_or_default()
    }

    fn finish(self) -> String {
        if self.carry.is_empty() {
            String::new()
        } else {
            String::from_utf8_lossy(&self.carry).into_owned()
        }
    }
}

const DEFAULT_HTTP_REQUEST_TIMEOUT_SECS: u64 = 120;

fn http_request_abort_registry() -> &'static Mutex<HashMap<String, AbortHandle>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, AbortHandle>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_http_abort_handle(request_id: &str, handle: AbortHandle) -> Result<(), String> {
    let mut registry = http_request_abort_registry()
        .lock()
        .map_err(|_| "HTTP 请求取消状态异常".to_string())?;
    registry.insert(request_id.to_string(), handle);
    Ok(())
}

fn remove_http_abort_handle(request_id: &str) -> Result<Option<AbortHandle>, String> {
    let mut registry = http_request_abort_registry()
        .lock()
        .map_err(|_| "HTTP 请求取消状态异常".to_string())?;
    Ok(registry.remove(request_id))
}

pub fn normalize_protocol(protocol: &str) -> &str {
    match protocol.trim() {
        "openai-responses" => "openai-responses",
        "anthropic-messages" => "anthropic-messages",
        _ => "openai-chat-completions",
    }
}

/// 根据 BASEURL 后缀规则构建请求端点：
/// - 末尾 `#`：不补全，直接向去掉 # 的 URL 发请求
/// - 末尾 `/`：只加资源路径（/chat/completions 或 /messages 等），不加 /v1
/// - 否则：不以 /v1 结尾则先补 /v1，再拼端点
pub fn build_protocol_endpoints(base_url: &str, protocol: &str, models_only: bool) -> Vec<String> {
    let raw = base_url.trim();
    if raw.is_empty() {
        return Vec::new();
    }

    let suffix = if models_only {
        "models"
    } else {
        match normalize_protocol(protocol) {
            "openai-responses" => "responses",
            "anthropic-messages" => "messages",
            _ => "chat/completions",
        }
    };

    if raw.ends_with('#') {
        let url = raw.trim_end_matches('#').trim();
        if url.is_empty() {
            return Vec::new();
        }
        return vec![url.to_string()];
    }

    if raw.ends_with('/') {
        let base = raw.trim_end_matches('/');
        return vec![format!("{}/{}", base, suffix)];
    }

    let base = raw.trim_end_matches('/');
    let base_with_v1 = if base.ends_with("/v1") {
        base.to_string()
    } else {
        format!("{}/v1", base)
    };
    vec![format!("{}/{}", base_with_v1, suffix)]
}

pub fn apply_protocol_headers(
    mut request: reqwest::RequestBuilder,
    protocol: &str,
    api_key: &str,
    accept: &str,
) -> reqwest::RequestBuilder {
    request = request.header(ACCEPT, accept);
    match normalize_protocol(protocol) {
        "anthropic-messages" => {
            request = request.header("anthropic-version", "2023-06-01");
            request = request.header("anthropic-beta", "prompt-caching-2024-07-31");
            if !api_key.trim().is_empty() {
                request = request.header("x-api-key", api_key.trim());
            }
            request
        }
        _ => {
            if !api_key.trim().is_empty() {
                request = request.bearer_auth(api_key.trim());
            }
            request
        }
    }
}

pub fn build_reqwest_client_with_proxy(
    proxy: Option<ProxySettings>,
    timeout_secs: Option<u64>,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().connect_timeout(Duration::from_secs(10));

    if let Some(timeout_secs) = timeout_secs {
        builder = builder.timeout(Duration::from_secs(timeout_secs));
    }

    if let Some(proxy_cfg) = proxy {
        let mode = proxy_cfg.mode.trim().to_lowercase();
        if mode != "off" {
            let raw_url = proxy_cfg.url.trim();
            if raw_url.is_empty() {
                return Err("代理已启用，但未填写代理 URL".to_string());
            }
            let url_with_scheme = if raw_url.starts_with("http://")
                || raw_url.starts_with("https://")
                || raw_url.starts_with("socks5://")
                || raw_url.starts_with("socks5h://")
            {
                raw_url.to_string()
            } else {
                format!("{}://{}", mode, raw_url)
            };
            let mut pxy = reqwest::Proxy::all(&url_with_scheme)
                .map_err(|e| format!("代理地址无效: {}", e))?;
            if let (Some(user), Some(pass)) = (proxy_cfg.username, proxy_cfg.password) {
                if !user.trim().is_empty() {
                    pxy = pxy.basic_auth(user.trim(), pass.trim());
                }
            }
            builder = builder.proxy(pxy);
            if let Some(no_proxy) = proxy_cfg.no_proxy {
                let cleaned = no_proxy
                    .split(',')
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(",");
                if !cleaned.is_empty() {
                    std::env::set_var("NO_PROXY", cleaned);
                }
            }
        }
    }

    builder
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败: {}", e))
}

#[tauri::command]
pub async fn fetch_url(
    url: String,
    max_size: Option<usize>,
    proxy: Option<ProxySettings>,
) -> Result<crate::domain::FetchResult, String> {
    let url_trimmed = url.trim();
    if url_trimmed.is_empty() {
        return Err("URL 不能为空".to_string());
    }

    let max_bytes = max_size
        .unwrap_or(config::FETCH_DEFAULT_MAX_BYTES)
        .min(config::FETCH_DEFAULT_MAX_BYTES);
    let client = build_reqwest_client_with_proxy(proxy, Some(30))?;
    let response = client
        .get(url_trimmed)
        .header(ACCEPT, "text/html,application/json,text/plain,*/*")
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        return Ok(crate::domain::FetchResult {
            success: false,
            url: url_trimmed.to_string(),
            content_type: None,
            content: String::new(),
            truncated: false,
            error: Some(format!("HTTP {}", status.as_u16())),
        });
    }

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;
    let truncated = bytes.len() > max_bytes;
    let content_bytes = if truncated {
        &bytes[..max_bytes]
    } else {
        &bytes[..]
    };
    let content = String::from_utf8_lossy(content_bytes).to_string();

    Ok(crate::domain::FetchResult {
        success: true,
        url: url_trimmed.to_string(),
        content_type,
        content,
        truncated,
        error: None,
    })
}

/// Streams an HTTP response back to JS as it arrives. Emits exactly one `head`
/// event with status/url/headers, then one `chunk` event per UTF-8-safe slice
/// from `response.bytes_stream()`, then one terminal `end` or `error`.
///
/// Replaces the prior buffered `perform_http_request` (which awaited the full
/// body before returning) so SSE responses from LLM providers are surfaced to
/// the JS-side `OpenAI`/`Anthropic` SDKs incrementally.
#[tauri::command]
pub async fn perform_http_request_stream(
    request_id: Option<String>,
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    proxy: Option<ProxySettings>,
    on_event: Channel<HttpStreamEvent>,
) -> Result<(), String> {
    let url_trimmed = url.trim();
    if url_trimmed.is_empty() {
        let _ = on_event.send(HttpStreamEvent::Error {
            message: "URL 不能为空".to_string(),
        });
        return Err("URL 不能为空".to_string());
    }

    let request_id = request_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    let request_url = url_trimmed.to_string();

    let (abort_handle, abort_registration) = AbortHandle::new_pair();
    if let Some(active_request_id) = request_id.as_deref() {
        if let Err(e) = register_http_abort_handle(active_request_id, abort_handle) {
            let _ = on_event.send(HttpStreamEvent::Error { message: e.clone() });
            return Err(e);
        }
    }

    let on_event_task = on_event.clone();
    let task = async move {
        let parsed_method = reqwest::Method::from_bytes(method.trim().as_bytes())
            .map_err(|e| format!("HTTP 方法无效: {}", e))?;
        let client =
            build_reqwest_client_with_proxy(proxy, Some(DEFAULT_HTTP_REQUEST_TIMEOUT_SECS))?;
        let mut request = client.request(parsed_method, request_url);

        for (name, value) in headers {
            if name.eq_ignore_ascii_case("content-length") || name.eq_ignore_ascii_case("host") {
                continue;
            }
            request = request.header(name, value);
        }

        if let Some(body) = body {
            request = request.body(body);
        }

        let response = request
            .send()
            .await
            .map_err(|e| format!("请求失败: {}", e))?;
        let status = response.status();
        let status_text = status.canonical_reason().unwrap_or("").to_string();
        let response_url = response.url().to_string();
        let response_headers: Vec<(String, String)> = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|v| (name.as_str().to_string(), v.to_string()))
            })
            .collect();

        let _ = on_event_task.send(HttpStreamEvent::Head {
            status: status.as_u16(),
            status_text,
            url: response_url,
            headers: response_headers,
        });

        let mut byte_stream = response.bytes_stream();
        let mut splitter = Utf8Splitter::new();
        while let Some(chunk_result) = byte_stream.next().await {
            match chunk_result {
                Ok(bytes) => {
                    let text = splitter.push(&bytes);
                    if !text.is_empty() {
                        let _ = on_event_task.send(HttpStreamEvent::Chunk { data: text });
                    }
                }
                Err(e) => return Err(format!("读取响应失败: {}", e)),
            }
        }
        let trailing = splitter.finish();
        if !trailing.is_empty() {
            let _ = on_event_task.send(HttpStreamEvent::Chunk { data: trailing });
        }

        Ok(())
    };

    let result = Abortable::new(task, abort_registration).await;

    if let Some(active_request_id) = request_id.as_deref() {
        let _ = remove_http_abort_handle(active_request_id)?;
    }

    match result {
        Ok(Ok(())) => {
            let _ = on_event.send(HttpStreamEvent::End);
            Ok(())
        }
        Ok(Err(msg)) => {
            let _ = on_event.send(HttpStreamEvent::Error {
                message: msg.clone(),
            });
            Err(msg)
        }
        Err(_) => {
            let _ = on_event.send(HttpStreamEvent::Error {
                message: "请求已取消".to_string(),
            });
            Err("请求已取消".to_string())
        }
    }
}

#[tauri::command]
pub fn cancel_http_request(request_id: String) -> Result<bool, String> {
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Ok(false);
    }

    let Some(abort_handle) = remove_http_abort_handle(request_id)? else {
        return Ok(false);
    };

    abort_handle.abort();
    Ok(true)
}
