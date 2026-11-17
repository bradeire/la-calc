//! Secrets (API keys, webhook signing secrets) live in the OS credential store —
//! Windows Credential Manager, macOS Keychain, Linux Secret Service — never in SQLite.

const SERVICE: &str = "uk.periopdigital.focus";

fn valid(key: &str) -> Result<(), String> {
    if !key.is_empty() && key.len() <= 100 && key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.')) {
        Ok(())
    } else {
        Err(format!("invalid secret name: {key:?}"))
    }
}

#[cfg(desktop)]
pub fn set(key: &str, value: &str) -> Result<(), String> {
    valid(key)?;
    keyring::Entry::new(SERVICE, key).and_then(|e| e.set_password(value)).map_err(|e| e.to_string())
}

#[cfg(desktop)]
pub fn get(key: &str) -> Result<Option<String>, String> {
    valid(key)?;
    match keyring::Entry::new(SERVICE, key).and_then(|e| e.get_password()) {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(desktop)]
pub fn delete(key: &str) -> Result<(), String> {
    valid(key)?;
    match keyring::Entry::new(SERVICE, key).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// Android: an in-app plugin (SecureStorePlugin.kt) encrypts values with an AES-256-GCM key held
// in the Android Keystore; only ciphertext is written to the app's private preferences.
#[cfg(target_os = "android")]
pub mod android {
    use serde::{Deserialize, Serialize};
    use tauri::{plugin::PluginHandle, Manager, Runtime};

    pub struct SecureStore<R: Runtime>(pub PluginHandle<R>);
    pub struct Share<R: Runtime>(pub PluginHandle<R>);
    pub struct BackgroundSync<R: Runtime>(pub PluginHandle<R>);

    /// Registers Focus's own Android plugins (SecureStorePlugin.kt, SharePlugin.kt, BackgroundSyncPlugin.kt).
    /// Each needs its own Tauri plugin name: Tauri routes Android commands by plugin name, so
    /// registering several under one name sent every command to the last one registered.
    pub fn init_secure_store<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
        tauri::plugin::Builder::new("focus-secure-store")
            .setup(|app, api| {
                app.manage(SecureStore(api.register_android_plugin("uk.periopdigital.focus", "SecureStorePlugin")?));
                Ok(())
            })
            .build()
    }
    pub fn init_share<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
        tauri::plugin::Builder::new("focus-share")
            .setup(|app, api| {
                app.manage(Share(api.register_android_plugin("uk.periopdigital.focus", "SharePlugin")?));
                Ok(())
            })
            .build()
    }
    pub fn init_background_sync<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
        tauri::plugin::Builder::new("focus-background-sync")
            .setup(|app, api| {
                app.manage(BackgroundSync(api.register_android_plugin("uk.periopdigital.focus", "BackgroundSyncPlugin")?));
                Ok(())
            })
            .build()
    }

    #[derive(Serialize)]
    struct BackgroundArgs<'a> {
        enabled: bool,
        root: &'a str,
    }
    pub fn configure_background_sync<R: Runtime>(app: &tauri::AppHandle<R>, enabled: bool, root: &str) -> Result<(), String> {
        let bg = app.try_state::<BackgroundSync<R>>().ok_or_else(|| "Background sync is not ready".to_string())?;
        bg.0.run_mobile_plugin::<()>("configure", BackgroundArgs { enabled, root }).map_err(|e| e.to_string())
    }

    #[derive(Serialize)]
    struct ShareArgs<'a> {
        name: &'a str,
        base64: &'a str,
        mime: &'a str,
    }
    pub fn share_file<R: Runtime>(app: &tauri::AppHandle<R>, name: &str, base64: &str, mime: &str) -> Result<(), String> {
        let share = app.try_state::<Share<R>>().ok_or_else(|| "Sharing is not ready".to_string())?;
        share.0.run_mobile_plugin::<()>("shareFile", ShareArgs { name, base64, mime }).map_err(|e| e.to_string())
    }

    #[derive(Serialize)]
    struct KeyArgs<'a> {
        key: &'a str,
    }
    #[derive(Serialize)]
    struct SetArgs<'a> {
        key: &'a str,
        value: &'a str,
    }
    #[derive(Deserialize)]
    struct GetResult {
        value: Option<String>,
    }

    fn store<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<tauri::State<'_, SecureStore<R>>, String> {
        app.try_state::<SecureStore<R>>().ok_or_else(|| "Secure storage is not ready".to_string())
    }
    pub fn set<R: Runtime>(app: &tauri::AppHandle<R>, key: &str, value: &str) -> Result<(), String> {
        super::valid(key)?;
        store(app)?.0.run_mobile_plugin::<()>("set", SetArgs { key, value }).map_err(|e| e.to_string())
    }
    pub fn get<R: Runtime>(app: &tauri::AppHandle<R>, key: &str) -> Result<Option<String>, String> {
        super::valid(key)?;
        store(app)?.0.run_mobile_plugin::<GetResult>("get", KeyArgs { key }).map(|r| r.value).map_err(|e| e.to_string())
    }
    pub fn delete<R: Runtime>(app: &tauri::AppHandle<R>, key: &str) -> Result<(), String> {
        super::valid(key)?;
        store(app)?.0.run_mobile_plugin::<()>("delete", KeyArgs { key }).map_err(|e| e.to_string())
    }
}

// iOS secure storage (Keychain) is not built yet.
#[cfg(target_os = "ios")]
pub fn set(_key: &str, _value: &str) -> Result<(), String> {
    Err("Secure storage is not available on this platform yet".into())
}
#[cfg(target_os = "ios")]
pub fn get(_key: &str) -> Result<Option<String>, String> {
    Ok(None)
}
#[cfg(target_os = "ios")]
pub fn delete(_key: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn rejects_bad_names() {
        assert!(super::valid("ai:openai").is_ok());
        assert!(super::valid("../x").is_err());
        assert!(super::valid("").is_err());
    }
}
