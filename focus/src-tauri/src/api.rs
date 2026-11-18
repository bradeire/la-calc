//! Optional local API (spec 6.7). Off by default; listens on 127.0.0.1 unless the user
//! explicitly allows their local network. Every request needs the bearer token. The server
//! only authenticates and forwards: the app's own services (in the webview) do the work, so
//! the API has exactly the same validation as the user interface.

use std::io::Read;
use std::net::SocketAddr;
use std::sync::Arc;
use std::thread;

use serde::Serialize;
use tiny_http::{Header, Method, Response, Server};

const MAX_BODY: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct ApiRequest {
    pub method: String,
    pub path: String,
    pub query: String,
    pub body: String,
}

#[derive(Debug, Clone)]
pub struct ApiResponse {
    pub status: u16,
    pub body: String,
}

impl ApiResponse {
    pub fn error(status: u16, message: &str) -> Self {
        ApiResponse { status, body: serde_json::json!({ "error": message }).to_string() }
    }
}

pub type Dispatch = Arc<dyn Fn(ApiRequest) -> ApiResponse + Send + Sync>;

pub struct ApiHandle {
    server: Arc<Server>,
    pub addr: SocketAddr,
}

impl ApiHandle {
    pub fn stop(&self) {
        self.server.unblock();
    }
}

impl Drop for ApiHandle {
    fn drop(&mut self) {
        self.server.unblock();
    }
}

/// Constant-time comparison so the token can't be guessed byte by byte from timings.
fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn header<'a>(headers: &'a [Header], name: &str) -> Option<&'a str> {
    headers.iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.as_str())
}

/// Checks that don't need the app: method, path, token, Host, browser origin, body size.
pub fn precheck(method: &Method, url: &str, headers: &[Header], token: &str, allow_lan: bool) -> Result<(String, String), ApiResponse> {
    // Browsers send Origin on cross-site requests; a web page must never drive the API.
    if header(headers, "origin").is_some() {
        return Err(ApiResponse::error(403, "Requests from web pages are not allowed"));
    }
    // DNS-rebinding protection: on localhost, only accept localhost Host names.
    if !allow_lan {
        let host = header(headers, "host").unwrap_or("");
        let name = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
        if !matches!(name, "127.0.0.1" | "localhost" | "[::1]") {
            return Err(ApiResponse::error(403, "Unexpected Host header"));
        }
    }
    let auth = header(headers, "authorization").unwrap_or("");
    let given = auth.strip_prefix("Bearer ").unwrap_or("");
    if token.is_empty() || !same(given, token) {
        return Err(ApiResponse::error(401, "Missing or wrong API token"));
    }
    if !matches!(method, Method::Get | Method::Post | Method::Patch) {
        return Err(ApiResponse::error(405, "Method not allowed"));
    }
    let (path, query) = url.split_once('?').unwrap_or((url, ""));
    if !path.starts_with("/v1/") || path.contains("..") || path.len() > 200 {
        return Err(ApiResponse::error(404, "Not found"));
    }
    Ok((path.to_string(), query.to_string()))
}

pub fn start(addr: SocketAddr, token: String, allow_lan: bool, dispatch: Dispatch) -> Result<ApiHandle, String> {
    let server = Arc::new(Server::http(addr).map_err(|e| format!("Could not start the API on {addr}: {e}"))?);
    let bound = match server.server_addr() {
        tiny_http::ListenAddr::IP(a) => a,
        #[allow(unreachable_patterns)]
        _ => addr,
    };
    let srv = server.clone();
    let token = Arc::new(token);
    thread::spawn(move || {
        for mut req in srv.incoming_requests() {
            let token = token.clone();
            let dispatch = dispatch.clone();
            thread::spawn(move || {
                let json = Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap();
                let nosniff = Header::from_bytes(&b"X-Content-Type-Options"[..], &b"nosniff"[..]).unwrap();
                let result = precheck(req.method(), req.url(), req.headers(), &token, allow_lan).and_then(|(path, query)| {
                    if req.body_length().unwrap_or(0) > MAX_BODY {
                        return Err(ApiResponse::error(413, "Request body too large"));
                    }
                    let mut body = String::new();
                    req.as_reader().take(MAX_BODY as u64 + 1).read_to_string(&mut body).map_err(|_| ApiResponse::error(400, "Body must be UTF-8 JSON"))?;
                    if body.len() > MAX_BODY {
                        return Err(ApiResponse::error(413, "Request body too large"));
                    }
                    Ok(ApiRequest { method: req.method().as_str().to_uppercase(), path, query, body })
                });
                let resp = match result {
                    Ok(r) => dispatch(r),
                    Err(e) => e,
                };
                let _ = req.respond(Response::from_string(resp.body).with_status_code(resp.status).with_header(json).with_header(nosniff));
            });
        }
    });
    Ok(ApiHandle { server, addr: bound })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpStream;

    fn raw(addr: SocketAddr, req: &str) -> (u16, String) {
        let mut s = TcpStream::connect(addr).unwrap();
        s.write_all(req.as_bytes()).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        let status = out[9..12].parse().unwrap();
        let body = out.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
        (status, body)
    }

    fn server() -> ApiHandle {
        let dispatch: Dispatch = Arc::new(|r: ApiRequest| ApiResponse { status: 200, body: serde_json::json!({ "echo": r.path, "q": r.query, "body": r.body, "m": r.method }).to_string() });
        start("127.0.0.1:0".parse().unwrap(), "s3cret-token".into(), false, dispatch).unwrap()
    }

    #[test]
    fn requires_the_token() {
        let h = server();
        let (s, _) = raw(h.addr, "GET /v1/tasks HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        assert_eq!(s, 401);
        let (s, _) = raw(h.addr, "GET /v1/tasks HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer wrong-token!\r\nConnection: close\r\n\r\n");
        assert_eq!(s, 401);
        let (s, body) = raw(h.addr, "GET /v1/tasks?status=open HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer s3cret-token\r\nConnection: close\r\n\r\n");
        assert_eq!(s, 200);
        assert!(body.contains("\"q\":\"status=open\""));
    }

    #[test]
    fn forwards_bodies_and_rejects_browsers_rebinding_and_bad_paths() {
        let h = server();
        let ok = "Host: localhost\r\nAuthorization: Bearer s3cret-token\r\nConnection: close\r\n";
        let payload = r#"{"title":"Milk"}"#;
        let (s, body) = raw(h.addr, &format!("POST /v1/tasks HTTP/1.1\r\n{ok}Content-Length: {}\r\n\r\n{payload}", payload.len()));
        assert_eq!(s, 200);
        assert!(body.contains("Milk") && body.contains("POST"));
        let (s, _) = raw(h.addr, &format!("POST /v1/tasks HTTP/1.1\r\n{ok}Origin: https://evil.example\r\n\r\n"));
        assert_eq!(s, 403);
        let (s, _) = raw(h.addr, "GET /v1/tasks HTTP/1.1\r\nHost: evil.example:1234\r\nAuthorization: Bearer s3cret-token\r\nConnection: close\r\n\r\n");
        assert_eq!(s, 403);
        let (s, _) = raw(h.addr, &format!("GET /admin HTTP/1.1\r\n{ok}\r\n"));
        assert_eq!(s, 404);
        let (s, _) = raw(h.addr, &format!("DELETE /v1/tasks/1 HTTP/1.1\r\n{ok}\r\n"));
        assert_eq!(s, 405);
    }

    #[test]
    fn constant_time_compare() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "abcd"));
    }
}
