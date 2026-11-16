mod http;
mod secrets;
mod storage;

use std::sync::Mutex;
use storage::Storage;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Manager, State};

/// Serialises all file operations so a save can never interleave with another.
struct AppStorage(Mutex<Storage>);

fn raw_body(request: &Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(_) => Err("expected a binary request body".into()),
    }
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
fn secret_set(key: String, value: String) -> Result<(), String> {
    secrets::set(&key, &value)
}

#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    secrets::get(&key)
}

#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    secrets::delete(&key)
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_load, db_load_previous, db_save, db_snapshot, file_put, file_get, file_exists, file_delete, file_keys, data_dir,
            secret_set, secret_get, secret_delete, http_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running Focus");
}
