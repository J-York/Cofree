import { useCallback, useEffect, useRef, useState } from "react";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  version: string;
  body: string;
  progress: number;
  error: string;
}

interface UpdateDownloadStartedEvent {
  event: "Started";
  data: { contentLength?: number };
}

interface UpdateDownloadProgressEvent {
  event: "Progress";
  data: { chunkLength: number };
}

interface UpdateDownloadFinishedEvent {
  event: "Finished";
}

type UpdateDownloadEvent =
  | UpdateDownloadStartedEvent
  | UpdateDownloadProgressEvent
  | UpdateDownloadFinishedEvent;

interface UpdateHandle {
  version: string;
  body?: string | null;
  downloadAndInstall: (onEvent: (event: UpdateDownloadEvent) => void) => Promise<void>;
}

interface UpdaterModule {
  check: () => Promise<UpdateHandle | null>;
}

interface ProcessModule {
  relaunch: () => Promise<void>;
}

const INITIAL: UpdateState = {
  status: "idle",
  version: "",
  body: "",
  progress: 0,
  error: "",
};

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const IS_DEV = import.meta.env.DEV;
const UPDATER_PLUGIN_SPECIFIER = "@tauri-apps/plugin-updater";
const PROCESS_PLUGIN_SPECIFIER = "@tauri-apps/plugin-process";

function normalizeUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/cancel/i.test(message)) {
    return "更新已取消。";
  }

  if (/signature|verify|pubkey/i.test(message)) {
    return "更新包校验失败，请稍后重试或联系开发者检查发布签名。";
  }

  if (/install|extract|replace|mount|permission|os error 13/i.test(message)) {
    return "更新包已下载，但安装失败。请关闭应用后手动安装，或稍后重试。";
  }

  return message;
}

async function importOptionalModule<T>(specifier: string): Promise<T | null> {
  try {
    return (await import(/* @vite-ignore */ specifier)) as T;
  } catch {
    return null;
  }
}

function loadUpdaterModule(): Promise<UpdaterModule | null> {
  return importOptionalModule<UpdaterModule>(UPDATER_PLUGIN_SPECIFIER);
}

function loadProcessModule(): Promise<ProcessModule | null> {
  return importOptionalModule<ProcessModule>(PROCESS_PLUGIN_SPECIFIER);
}

export function useUpdater() {
  const [state, setState] = useState<UpdateState>(INITIAL);
  const updateRef = useRef<UpdateHandle | null>(null);
  const dismissedVersion = useRef<string | null>(null);
  const checkingRef = useRef(false);

  const checkForUpdate = useCallback(async () => {
    if (IS_DEV) return;
    if (checkingRef.current) return;
    if (
      dismissedVersion.current &&
      state.status === "error" &&
      state.version === dismissedVersion.current
    ) {
      return;
    }

    checkingRef.current = true;
    setState((s) => ({ ...s, status: "checking", error: "" }));

    try {
      const updaterModule = await loadUpdaterModule();
      if (!updaterModule) {
        updateRef.current = null;
        setState(INITIAL);
        return;
      }

      const update = await updaterModule.check();
      if (update) {
        if (update.version === dismissedVersion.current) {
          setState(INITIAL);
          return;
        }
        updateRef.current = update;
        setState({
          status: "available",
          version: update.version,
          body: update.body ?? "",
          progress: 0,
          error: "",
        });
      } else {
        updateRef.current = null;
        setState(INITIAL);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/pubkey|signature|verify/i.test(msg)) {
        console.warn("[updater] Signature verification failed — is pubkey configured?", msg);
        setState(INITIAL);
      } else {
        setState((s) => ({ ...s, status: "error", error: normalizeUpdateError(e) }));
      }
    } finally {
      checkingRef.current = false;
    }
  }, [state.status, state.version]);

  const installUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;

    setState((s) => ({ ...s, status: "downloading", progress: 0, error: "" }));

    try {
      let totalLength = 0;
      let downloaded = 0;

      await update.downloadAndInstall((event: UpdateDownloadEvent) => {
        switch (event.event) {
          case "Started":
            totalLength = event.data.contentLength ?? 0;
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            if (totalLength > 0) {
              setState((s) => ({
                ...s,
                status: "downloading",
                progress: Math.round((downloaded / totalLength) * 100),
              }));
            }
            break;
          case "Finished":
            setState((s) => ({ ...s, status: "installing", progress: 100 }));
            break;
        }
      });

      const processModule = await loadProcessModule();
      if (processModule) {
        await processModule.relaunch();
      }
    } catch (e) {
      dismissedVersion.current = update.version;
      setState((s) => ({
        ...s,
        status: "error",
        error: normalizeUpdateError(e),
      }));
    }
  }, []);

  const dismiss = useCallback(() => {
    dismissedVersion.current = state.version;
    setState(INITIAL);
  }, [state.version]);

  useEffect(() => {
    if (IS_DEV) return;

    const timer = setTimeout(() => {
      void checkForUpdate();
    }, 3000);

    const interval = setInterval(() => {
      void checkForUpdate();
    }, CHECK_INTERVAL_MS);

    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [checkForUpdate]);

  return {
    ...state,
    visible:
      state.status === "available" ||
      state.status === "downloading" ||
      state.status === "installing" ||
      state.status === "error",
    checkForUpdate,
    installUpdate,
    dismiss,
  };
}
