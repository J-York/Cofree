import { invoke } from "@tauri-apps/api/core";

const DEFAULT_VENDOR_ID = "vendor-default";

function vendorSecretSlot(vendorId: string): string {
  return `vendor:${vendorId}`;
}

function legacyVendorSecretSlot(vendorId: string): string | null | undefined {
  if (vendorId === DEFAULT_VENDOR_ID) {
    return undefined;
  }

  if (vendorId.startsWith("vendor-profile-")) {
    return vendorId.slice("vendor-".length);
  }

  return null;
}

export async function loadSecureApiKey(secretSlot?: string | null): Promise<string> {
  try {
    const value = await invoke<string>("load_secure_api_key", { profileId: secretSlot || null });
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

export async function saveSecureApiKey(apiKey: string, secretSlot?: string | null): Promise<void> {
  await invoke("save_secure_api_key", {
    profileId: secretSlot || null,
    apiKey,
  });
}

export async function deleteSecureApiKey(secretSlot: string): Promise<void> {
  await invoke("delete_secure_api_key", { profileId: secretSlot });
}

export async function loadVendorApiKey(vendorId?: string | null): Promise<string> {
  if (!vendorId) {
    return "";
  }

  const currentSlot = vendorSecretSlot(vendorId);
  const currentKey = await loadSecureApiKey(currentSlot);
  if (currentKey) {
    return currentKey;
  }

  const legacySlot = legacyVendorSecretSlot(vendorId);
  if (legacySlot === null) {
    return "";
  }

  const legacyKey = await loadSecureApiKey(legacySlot);
  if (!legacyKey) {
    return "";
  }

  try {
    await saveSecureApiKey(legacyKey, currentSlot);
  } catch {
    // ignore secure-storage migration failures and still return the recovered key
  }

  return legacyKey;
}

export async function saveVendorApiKey(vendorId: string, apiKey: string): Promise<void> {
  await saveSecureApiKey(apiKey, vendorSecretSlot(vendorId));
}

export async function deleteVendorApiKey(vendorId: string): Promise<void> {
  await deleteSecureApiKey(vendorSecretSlot(vendorId));
}

export function maskApiKey(key: string): string {
  if (!key) {
    return "未设置";
  }

  if (key.length <= 8) {
    return "*".repeat(key.length);
  }

  return `${key.slice(0, 4)}${"*".repeat(Math.max(4, key.length - 8))}${key.slice(-4)}`;
}
