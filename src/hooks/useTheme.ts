import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

export type ThemeMode = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "cofree-theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia(MEDIA_QUERY).matches ? "dark" : "light";
}

function getStoredTheme(): ThemeMode {
  if (typeof window === "undefined") return "dark";
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "dark" || stored === "light" || stored === "system") {
    return stored;
  }
  return "dark";
}

function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = resolved;
}

// External store for media query changes
let mediaQueryListeners: Set<() => void> = new Set();
let cachedSystemTheme: ResolvedTheme = "dark";

if (typeof window !== "undefined") {
  cachedSystemTheme = getSystemTheme();
  const mediaQuery = window.matchMedia(MEDIA_QUERY);
  mediaQuery.addEventListener("change", () => {
    cachedSystemTheme = getSystemTheme();
    mediaQueryListeners.forEach((listener) => listener());
  });
}

function subscribeToSystemTheme(callback: () => void): () => void {
  mediaQueryListeners.add(callback);
  return () => {
    mediaQueryListeners.delete(callback);
  };
}

function getSystemThemeSnapshot(): ResolvedTheme {
  return cachedSystemTheme;
}

export interface UseThemeReturn {
  /** Current theme setting: 'dark' | 'light' | 'system' */
  theme: ThemeMode;
  /** Set theme mode */
  setTheme: (mode: ThemeMode) => void;
  /** Resolved theme that is actually applied: 'dark' | 'light' */
  resolvedTheme: ResolvedTheme;
}

export function useTheme(): UseThemeReturn {
  const [theme, setThemeState] = useState<ThemeMode>(getStoredTheme);
  
  // Subscribe to system theme changes
  const systemTheme = useSyncExternalStore(
    subscribeToSystemTheme,
    getSystemThemeSnapshot,
    () => "dark" as ResolvedTheme
  );

  const resolvedTheme: ResolvedTheme = theme === "system" ? systemTheme : theme;

  // Apply theme to DOM whenever resolved theme changes
  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = useCallback((mode: ThemeMode) => {
    setThemeState(mode);
    localStorage.setItem(STORAGE_KEY, mode);
  }, []);

  return {
    theme,
    setTheme,
    resolvedTheme,
  };
}

/** Get display label for current theme mode */
export function getThemeLabel(mode: ThemeMode): string {
  switch (mode) {
    case "dark":
      return "深色";
    case "light":
      return "浅色";
    case "system":
      return "跟随系统";
  }
}

/** Get next theme in rotation: dark → light → system → dark */
export function getNextTheme(current: ThemeMode): ThemeMode {
  switch (current) {
    case "dark":
      return "light";
    case "light":
      return "system";
    case "system":
      return "dark";
  }
}
