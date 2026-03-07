/// Encrypted file-based credential store.
///
/// Uses AES-256-GCM with a randomly generated master key stored alongside
/// the encrypted data in `~/.cofree/`. This avoids macOS Keychain access
/// prompts entirely while still keeping API keys encrypted on disk.
///
/// Security model:
/// - Master key (`keystore.key`): 32 random bytes, file permissions 0600 on Unix.
/// - Credential store (`keystore.json`): each entry encrypted with a unique nonce.
/// - On Windows the user profile directory ACL provides equivalent protection.
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const KEY_LEN: usize = 32; // AES-256
const NONCE_LEN: usize = 12; // AES-GCM standard nonce

// ── Encrypted entry ──────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
struct EncryptedEntry {
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}

#[derive(Serialize, Deserialize, Default)]
struct KeyStore {
    entries: HashMap<String, EncryptedEntry>,
}

// ── Paths ────────────────────────────────────────────────────────────────────

fn store_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法获取用户主目录".to_string())?;
    Ok(home.join(".cofree"))
}

fn key_file_path() -> Result<PathBuf, String> {
    Ok(store_dir()?.join("keystore.key"))
}

fn data_file_path() -> Result<PathBuf, String> {
    Ok(store_dir()?.join("keystore.json"))
}

// ── Restricted file writes ───────────────────────────────────────────────────

/// Write `content` to `path` with 0600 permissions set atomically at creation
/// time (Unix) so the file is never readable by other users, even briefly.
#[cfg(unix)]
fn write_restricted(path: &std::path::Path, content: &[u8]) -> Result<(), String> {
    use std::io::Write as IoWrite;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("创建受限文件失败 {}: {}", path.display(), e))?;
    file.write_all(content)
        .map_err(|e| format!("写入文件失败 {}: {}", path.display(), e))
}

#[cfg(not(unix))]
fn write_restricted(path: &std::path::Path, content: &[u8]) -> Result<(), String> {
    fs::write(path, content).map_err(|e| format!("写入文件失败 {}: {}", path.display(), e))
}

// ── Master key management ────────────────────────────────────────────────────

fn ensure_master_key() -> Result<Vec<u8>, String> {
    let path = key_file_path()?;

    if path.exists() {
        let key = fs::read(&path).map_err(|e| format!("读取密钥文件失败: {}", e))?;
        if key.len() == KEY_LEN {
            return Ok(key);
        }
        return Err(format!(
            "密钥文件长度异常 (期望 {} 字节, 实际 {} 字节)",
            KEY_LEN,
            key.len()
        ));
    }

    // First run: generate a new random master key
    let rng = SystemRandom::new();
    let mut key = vec![0u8; KEY_LEN];
    rng.fill(&mut key)
        .map_err(|_| "生成随机密钥失败".to_string())?;

    let dir = store_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建密钥目录失败: {}", e))?;
    write_restricted(&path, &key)?;

    Ok(key)
}

// ── AES-256-GCM encrypt / decrypt ───────────────────────────────────────────

fn make_key(raw: &[u8]) -> Result<LessSafeKey, String> {
    let unbound =
        UnboundKey::new(&AES_256_GCM, raw).map_err(|_| "创建 AES 密钥失败".to_string())?;
    Ok(LessSafeKey::new(unbound))
}

fn encrypt(master_key: &[u8], plaintext: &str) -> Result<EncryptedEntry, String> {
    let rng = SystemRandom::new();
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rng.fill(&mut nonce_bytes)
        .map_err(|_| "生成 nonce 失败".to_string())?;

    let key = make_key(master_key)?;
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);

    let mut buf = plaintext.as_bytes().to_vec();
    key.seal_in_place_append_tag(nonce, Aad::empty(), &mut buf)
        .map_err(|_| "加密失败".to_string())?;

    Ok(EncryptedEntry {
        nonce: nonce_bytes.to_vec(),
        ciphertext: buf,
    })
}

fn decrypt(master_key: &[u8], entry: &EncryptedEntry) -> Result<String, String> {
    if entry.nonce.len() != NONCE_LEN {
        return Err("nonce 长度无效".to_string());
    }

    let key = make_key(master_key)?;

    let mut nonce_bytes = [0u8; NONCE_LEN];
    nonce_bytes.copy_from_slice(&entry.nonce);
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);

    let mut buf = entry.ciphertext.clone();
    let plaintext = key
        .open_in_place(nonce, Aad::empty(), &mut buf)
        .map_err(|_| "解密失败（密钥文件可能已变更）".to_string())?;

    String::from_utf8(plaintext.to_vec()).map_err(|_| "解密结果不是有效 UTF-8".to_string())
}

// ── Store file I/O ───────────────────────────────────────────────────────────

fn load_store() -> Result<KeyStore, String> {
    let path = data_file_path()?;
    if !path.exists() {
        return Ok(KeyStore::default());
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("读取密钥库失败: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("解析密钥库失败: {}", e))
}

fn save_store(store: &KeyStore) -> Result<(), String> {
    let dir = store_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建密钥目录失败: {}", e))?;

    let path = data_file_path()?;
    let content =
        serde_json::to_string_pretty(store).map_err(|e| format!("序列化密钥库失败: {}", e))?;
    write_restricted(&path, content.as_bytes())?;

    Ok(())
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Load an API key. Returns `Ok("")` when no entry exists.
pub fn load(user: &str) -> Result<String, String> {
    let master_key = ensure_master_key()?;
    let store = load_store()?;

    match store.entries.get(user) {
        Some(entry) => match decrypt(&master_key, entry) {
            Ok(v) => Ok(v),
            Err(_) => Ok(String::new()),
        },
        None => Ok(String::new()),
    }
}

/// Save (or clear) an API key.
pub fn save(user: &str, api_key: &str) -> Result<(), String> {
    let master_key = ensure_master_key()?;
    let mut store = load_store()?;

    if api_key.trim().is_empty() {
        store.entries.remove(user);
    } else {
        let entry = encrypt(&master_key, api_key.trim())?;
        store.entries.insert(user.to_string(), entry);
    }

    save_store(&store)
}

/// Remove an API key entry.
pub fn delete(user: &str) -> Result<(), String> {
    let mut store = load_store()?;
    if store.entries.remove(user).is_some() {
        save_store(&store)?;
    }
    Ok(())
}
