mod http;
mod exports;
pub mod bgsync;
#[cfg(desktop)]
mod api;
mod secrets;
mod storage;

use std::sync::Mutex;
use storage::Storage;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Manager, State};

/// Serialises all file operations so a save can never interleave with another.
struct AppStorage(Mutex<Storage>);

/// Binary request bodies. Desktop sends raw bytes; Android's WebView can't pass a raw body to
/// Rust, so Tauri sends JSON there: the app sends `{ "b64": "…" }`, and a plain array of numbers
/// (what Tauri makes of a Uint8Array on Android) is accepted too.
fn body_bytes(body: &InvokeBody) -> Result<Vec<u8>, String> {
    use base64::Engine;
    match body {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(serde_json::Value::Object(o)) => match o.get("b64") {
            Some(serde_json::Value::String(s)) => base64::engine::general_purpose::STANDARD.decode(s).map_err(|e| format!("invalid base64 body: {e}")),
            _ => Err("expected a binary request body".into()),
        },
        InvokeBody::Json(serde_json::Value::Array(items)) => items
            .iter()
            .map(|v| v.as_u64().filter(|n| *n <= 255).map(|n| n as u8).ok_or_else(|| "expected a byte array".to_string()))
            .collect(),
        InvokeBody::Json(_) => Err("expected a binary request body".into()),
    }
}

fn raw_body(request: &Request<'_>) -> Result<Vec<u8>, String> {
    body_bytes(request.body())
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Result<&'a str, String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("missing header {name}"))
}

fn bytes_or_empty(v: Option<Vec<u8>>) -> Response {
    Response::new(v.unwrap_or_default())
}

#[tauri::command]
fn db_load(state: State<'_, AppStorage>) -> Result<Response, String> {
    Ok(bytes_or_empty(state.0.lock().map_err(|e| e.to_string())?.load()?))
}

#[tauri::command]
fn db_load_previous(state: State<'_, AppStorage>) -> Result<Response, String> {
    Ok(bytes_or_empty(state.0.lock().map_err(|e| e.to_string())?.load_previous()?))
}

#[tauri::command]
fn db_save(request: Request<'_>, state: State<'_, AppStorage>) -> Result<(), String> {
    let bytes = raw_body(&request)?;
    state.0.lock().map_err(|e| e.to_string())?.save(&bytes)
}

#[tauri::command]
fn db_snapshot(request: Request<'_>, state: State<'_, AppStorage>) -> Result<(), String> {
    let bytes = raw_body(&request)?;
    let name = header(&request, "x-focus-name")?;
    state.0.lock().map_err(|e| e.to_string())?.save_snapshot(name, &bytes)
}

#[tauri::command]
fn file_put(request: Request<'_>, state: State<'_, AppStorage>) -> Result<(), String> {
    let bytes = raw_body(&request)?;
    let key = header(&request, "x-focus-key")?;
    state.0.lock().map_err(|e| e.to_string())?.file_put(key, &bytes)
}

#[tauri::command]
fn file_get(key: String, state: State<'_, AppStorage>) -> Result<Response, String> {
    Ok(bytes_or_empty(state.0.lock().map_err(|e| e.to_string())?.file_get(&key)?))
}

#[tauri::command]
fn file_exists(key: String, state: State<'_, AppStorage>) -> Result<bool, String> {
    Ok(state.0.lock().map_err(|e| e.to_string())?.file_get(&key)?.is_some())
}

#[tauri::command]
fn file_delete(key: String, state: State<'_, AppStorage>) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.file_delete(&key)
}

#[tauri::command]
fn file_keys(state: State<'_, AppStorage>) -> Result<Vec<String>, String> {
    state.0.lock().map_err(|e| e.to_string())?.file_keys()
}

#[tauri::command]
fn data_dir(state: State<'_, AppStorage>) -> Result<String, String> {
    Ok(state.0.lock().map_err(|e| e.to_string())?.root().display().to_string())
}

#[tauri::command]
async fn secret_set(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    return secrets::android::set(&app, &key, &value);
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        secrets::set(&key, &value)
    }
}

#[tauri::command]
async fn secret_get(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    return secrets::android::get(&app, &key);
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        secrets::get(&key)
    }
}

#[tauri::command]
async fn secret_delete(app: tauri::AppHandle, key: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    return secrets::android::delete(&app, &key);
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        secrets::delete(&key)
    }
}

/// Save an export: desktop writes it to the Downloads folder (returns the path);
/// Android opens the share sheet (returns None).
#[tauri::command]
async fn export_file(app: tauri::AppHandle, name: String, base64: String, mime: String) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        let _ = &mime;
        secrets::android::share_file(&app, &name, &base64, &mime)?;
        return Ok(None);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &mime;
        let bytes = exports::decode_base64(&base64)?;
        let dir = app.path().download_dir().map_err(|e| e.to_string())?;
        let path = exports::unique_path(&dir, &name)?;
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        Ok(Some(path.to_string_lossy().into_owned()))
    }
}

// ---------- Local API bridge (desktop) ----------

#[derive(Default)]
struct ApiState {
    #[cfg(desktop)]
    handle: Mutex<Option<api::ApiHandle>>,
    #[cfg(desktop)]
    pending: std::sync::Arc<Mutex<std::collections::HashMap<u64, std::sync::mpsc::Sender<api::ApiResponse>>>>,
    #[cfg(desktop)]
    next: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

/// Start (or restart) the local API. Returns the address it listens on.
#[tauri::command]
fn api_start(app: tauri::AppHandle, state: State<'_, ApiState>, port: u16, token: String, allow_lan: bool) -> Result<String, String> {
    #[cfg(desktop)]
    {
        use std::sync::atomic::Ordering;
        use tauri::Emitter;
        if token.len() < 32 {
            return Err("API token too short".into());
        }
        if let Some(h) = state.handle.lock().unwrap().take() {
            h.stop();
        }
        let ip = if allow_lan { "0.0.0.0" } else { "127.0.0.1" };
        let addr: std::net::SocketAddr = format!("{ip}:{port}").parse().map_err(|e| format!("{e}"))?;
        let pending = state.pending.clone();
        let next = state.next.clone();
        let dispatch: api::Dispatch = std::sync::Arc::new(move |req: api::ApiRequest| {
            let id = next.fetch_add(1, Ordering::SeqCst);
            let (tx, rx) = std::sync::mpsc::channel();
            pending.lock().unwrap().insert(id, tx);
            #[derive(serde::Serialize, Clone)]
            struct Event {
                id: u64,
                #[serde(flatten)]
                req: api::ApiRequest,
            }
            if app.emit_to("main", "focus-api-request", Event { id, req }).is_err() {
                pending.lock().unwrap().remove(&id);
                return api::ApiResponse::error(503, "Focus is not ready");
            }
            match rx.recv_timeout(std::time::Duration::from_secs(15)) {
                Ok(r) => r,
                Err(_) => {
                    pending.lock().unwrap().remove(&id);
                    api::ApiResponse::error(504, "Focus didn't answer in time (is the window open?)")
                }
            }
        });
        let handle = api::start(addr, token, allow_lan, dispatch)?;
        let bound = handle.addr.to_string();
        *state.handle.lock().unwrap() = Some(handle);
        Ok(bound)
    }
    #[cfg(mobile)]
    {
        let _ = (app, state, port, token, allow_lan);
        Err("The local API is available in the desktop app only".into())
    }
}

#[tauri::command]
fn api_stop(state: State<'_, ApiState>) {
    #[cfg(desktop)]
    if let Some(h) = state.handle.lock().unwrap().take() {
        h.stop();
    }
    #[cfg(mobile)]
    let _ = state;
}

/// The webview's answer to a forwarded request.
#[tauri::command]
fn api_respond(state: State<'_, ApiState>, id: u64, status: u16, body: String) {
    #[cfg(desktop)]
    if let Some(tx) = state.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(api::ApiResponse { status, body });
    }
    #[cfg(mobile)]
    let _ = (state, id, status, body);
}

/// Android: schedule (or cancel) the periodic background sync of the app's database.
#[tauri::command]
async fn background_sync(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
        secrets::android::configure_background_sync(&app, enabled, &root.to_string_lossy())?;
        return Ok(true);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, enabled);
        Ok(false)
    }
}

#[tauri::command]
async fn http_request(request: http::HttpRequest) -> Result<http::HttpResponse, String> {
    http::send(request).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        // A second launch focuses the existing window instead of opening a second
        // copy that could overwrite the first one's data.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }
    #[cfg(target_os = "android")]
    {
        builder = builder
            .plugin(secrets::android::init_secure_store())
            .plugin(secrets::android::init_share())
            .plugin(secrets::android::init_background_sync());
    }
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Installers register focus:// on Windows/Linux; registering again at start-up also covers
            // portable and development runs. Failure only means links won't open the app.
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }
            let dir = app.path().app_data_dir()?;
            let storage = Storage::new(dir).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            app.manage(AppStorage(Mutex::new(storage)));
            app.manage(ApiState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_load, db_load_previous, db_save, db_snapshot, file_put, file_get, file_exists, file_delete, file_keys, data_dir,
            secret_set, secret_get, secret_delete, http_request, export_file, api_start, api_stop, api_respond, background_sync
        ])
        .run(tauri::generate_context!())
        .expect("error while running Focus");
}

#[cfg(test)]
mod body_tests {
    use super::*;

    #[test]
    fn binary_bodies_arrive_from_every_platform() {
        let want = b"SQLite format 3\0abc".to_vec();
        assert_eq!(body_bytes(&InvokeBody::Raw(want.clone())).unwrap(), want);
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &want);
        assert_eq!(body_bytes(&InvokeBody::Json(serde_json::json!({ "b64": b64 }))).unwrap(), want);
        assert_eq!(body_bytes(&InvokeBody::Json(serde_json::json!(want))).unwrap(), want);
        assert!(body_bytes(&InvokeBody::Json(serde_json::json!([1, 300]))).is_err());
        assert!(body_bytes(&InvokeBody::Json(serde_json::json!({ "b64": "!!" }))).is_err());
        assert!(body_bytes(&InvokeBody::Json(serde_json::json!({}))).is_err());
    }
}
