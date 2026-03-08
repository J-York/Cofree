use crate::config;
use crate::domain::ProxySettings;
use reqwest::header::ACCEPT;
use std::time::Duration;

pub fn normalize_base_url(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_string()
}

pub fn normalize_protocol(protocol: &str) -> &str {
    match protocol.trim() {
        "openai-responses" => "openai-responses",
        "anthropic-messages" => "anthropic-messages",
        _ => "openai-chat-completions",
    }
}

pub fn build_protocol_endpoints(base_url: &str, protocol: &str, models_only: bool) -> Vec<String> {
    let normalized = normalize_base_url(base_url);
    if normalized.is_empty() {
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

    // Anthropic 端点需要 /v1 前缀，自动补全
    // 最终格式：base_url/v1/messages
    let base_with_v1 = if normalized.ends_with("/v1") {
        normalized.to_string()
    } else {
        format!("{}/v1", normalized)
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
    timeout_secs: u64,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .connect_timeout(Duration::from_secs(10));

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
    let client = build_reqwest_client_with_proxy(proxy, 30)?;
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
