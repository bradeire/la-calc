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

// Mobile secure storage (Android Keystore / iOS Keychain) arrives with the mobile builds.
#[cfg(mobile)]
pub fn set(_key: &str, _value: &str) -> Result<(), String> {
    Err("Secure storage is not available on this platform yet".into())
}
#[cfg(mobile)]
pub fn get(_key: &str) -> Result<Option<String>, String> {
    Ok(None)
}
#[cfg(mobile)]
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
