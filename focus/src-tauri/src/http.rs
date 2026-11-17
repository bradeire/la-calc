//! Outbound HTTP for user-configured integrations only (AI providers, webhooks).
//! Runs in Rust so the webview's Content-Security-Policy can stay strict and
//! local services (e.g. Ollama) are reachable without CORS configuration.

use serde::{Deserialize, Serialize};
use std::time::Duration;

// Calendar feeds with years of history can be several megabytes.
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

pub fn validate(req: &HttpRequest) -> Result<reqwest::Method, String> {
    let url = reqwest::Url::parse(&req.url).map_err(|e| format!("invalid URL: {e}"))?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("only http and https URLs are allowed".into());
    }
    match req.method.to_ascii_uppercase().as_str() {
        "GET" => Ok(reqwest::Method::GET),
        "POST" => Ok(reqwest::Method::POST),
        other => Err(format!("method {other} is not allowed")),
    }
}

/// An HTTP client builder that works on every platform. On Android, reqwest's default
/// (the OS certificate verifier) needs JVM initialisation the app doesn't do, which made every
/// HTTPS request fail there; Mozilla's root certificates are used instead.
pub fn client_builder() -> reqwest::ClientBuilder {
    let builder = reqwest::Client::builder();
    #[cfg(target_os = "android")]
    let builder = builder.tls_certs_only(webpki_root_certs::TLS_SERVER_ROOT_CERTS.iter().filter_map(|c| reqwest::Certificate::from_der(c.as_ref()).ok()));
    builder
}

pub async fn send(req: HttpRequest) -> Result<HttpResponse, String> {
    let method = validate(&req)?;
    let client = client_builder()
        .timeout(Duration::from_millis(req.timeout_ms.unwrap_or(30_000).min(120_000)))
        .user_agent("Focus")
        .build()
        .map_err(|e| e.to_string())?;
    let mut builder = client.request(method, &req.url);
    for (k, v) in &req.headers {
        builder = builder.header(k, v);
    }
    if let Some(body) = req.body {
        builder = builder.body(body);
    }
    let resp = builder.send().await.map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status().as_u16();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("response too large".into());
    }
    Ok(HttpResponse { status, body: String::from_utf8_lossy(&bytes).into_owned() })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn req(method: &str, url: &str) -> HttpRequest {
        HttpRequest { method: method.into(), url: url.into(), headers: vec![], body: None, timeout_ms: None }
    }
    #[test]
    fn validates_scheme_and_method() {
        assert!(validate(&req("POST", "https://example.com/hook")).is_ok());
        assert!(validate(&req("GET", "http://localhost:11434/api/tags")).is_ok());
        assert!(validate(&req("POST", "file:///etc/passwd")).is_err());
        assert!(validate(&req("DELETE", "https://example.com")).is_err());
    }
}
