use crate::config::{KEYRING_DEFAULT_USER, KEYRING_SERVICE_NAME};
use crate::secure_store;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

fn keyring_user_for_profile(profile_id: Option<&str>) -> String {
    match profile_id {
        Some(id) if !id.trim().is_empty() => format!("profile-{}", id.trim()),
        _ => KEYRING_DEFAULT_USER.to_string(),
    }
}

fn api_key_cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn keyring_load(user: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE_NAME, user)
        .map_err(|e| format!("创建 keyring entry 失败: {}", e))?;
    match entry.get_password() {
        Ok(password) => Ok(password),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(format!("读取密钥失败: {}", e)),
    }
}

fn keyring_delete_best_effort(user: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE_NAME, user) {
        let _ = entry.delete_credential();
    }
}

fn load_secure_api_key_impl(profile_id: Option<&str>) -> Result<String, String> {
    let user = keyring_user_for_profile(profile_id);
    if let Ok(cache) = api_key_cache().lock() {
        if let Some(cached) = cache.get(&user) {
            return Ok(cached.clone());
        }
    }
    if let Ok(value) = secure_store::load(&user) {
        if !value.is_empty() {
            if let Ok(mut cache) = api_key_cache().lock() {
                cache.insert(user, value.clone());
            }
            return Ok(value);
        }
    }
    let password = keyring_load(&user).unwrap_or_default();
    if !password.is_empty() {
        let _ = secure_store::save(&user, &password);
        keyring_delete_best_effort(&user);
    }
    if let Ok(mut cache) = api_key_cache().lock() {
        cache.insert(user, password.clone());
    }
    Ok(password)
}

fn save_secure_api_key_impl(profile_id: Option<&str>, api_key: &str) -> Result<(), String> {
    let user = keyring_user_for_profile(profile_id);
    secure_store::save(&user, api_key)?;
    if api_key.trim().is_empty() {
        keyring_delete_best_effort(&user);
    }
    if let Ok(mut cache) = api_key_cache().lock() {
        cache.insert(
            user,
            if api_key.trim().is_empty() {
                String::new()
            } else {
                api_key.trim().to_string()
            },
        );
    }
    Ok(())
}

fn delete_secure_api_key_impl(profile_id: &str) -> Result<(), String> {
    let user = keyring_user_for_profile(Some(profile_id));
    secure_store::delete(&user)?;
    keyring_delete_best_effort(&user);
    if let Ok(mut cache) = api_key_cache().lock() {
        cache.remove(&user);
    }
    Ok(())
}

#[tauri::command]
pub fn load_secure_api_key(profile_id: Option<String>) -> Result<String, String> {
    load_secure_api_key_impl(profile_id.as_deref())
}

#[tauri::command]
pub fn save_secure_api_key(profile_id: Option<String>, api_key: String) -> Result<(), String> {
    save_secure_api_key_impl(profile_id.as_deref(), &api_key)
}

#[tauri::command]
pub fn delete_secure_api_key(profile_id: String) -> Result<(), String> {
    delete_secure_api_key_impl(&profile_id)
}
