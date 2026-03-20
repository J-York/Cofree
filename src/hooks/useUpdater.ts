import { useCallback, useEffect, useRef, useState } from "react";
import { classifyUpdateError } from "./updaterErrors";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "error";

export type UpdateErrorAction = "check" | "install" | null;

export interface UpdateState {
  status: UpdateStatus;
  version: string;
  body: string;
  progress: number;
  error: string;
  errorAction: UpdateErrorAction;
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
  errorAction: null,
};

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const IS_DEV = import.meta.env.DEV;
const UPDATER_PLUGIN_SPECIFIER = "@tauri-apps/plugin-updater";
const PROCESS_PLUGIN_SPECIFIER = "@tauri-apps/plugin-process";

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
    setState((s) => ({ ...s, status: "checking", error: "", errorAction: null }));

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
          errorAction: null,
        });
      } else {
        updateRef.current = null;
        setState(INITIAL);
      }
    } catch (e) {
      const classifiedError = classifyUpdateError(e);

      // Signature and pubkey failures are operationally important. Treating them as
      // "no update" hides broken releases from both operators and users.
      console.error("[updater] Update check failed", e);
      updateRef.current = null;
      setState({
        ...INITIAL,
        status: "error",
        error: classifiedError.message,
        errorAction: "check",
      });
    } finally {
      checkingRef.current = false;
    }
  }, [state.status, state.version]);

  const installUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;

    setState((s) => ({ ...s, status: "downloading", progress: 0, error: "", errorAction: null }));

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
      const classifiedError = classifyUpdateError(e);

      console.error("[updater] Update install failed", e);
      setState({
        status: "error",
        version: update.version,
        body: update.body ?? "",
        progress: 0,
        error: classifiedError.message,
        errorAction: "install",
      });
    }
  }, []);

  const retry = useCallback(async () => {
    if (state.status !== "error") return;

    if (state.errorAction === "install" && updateRef.current) {
      await installUpdate();
      return;
    }

    await checkForUpdate();
  }, [checkForUpdate, installUpdate, state.errorAction, state.status]);

  const dismiss = useCallback(() => {
    if (state.version) {
      dismissedVersion.current = state.version;
    }
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
    retry,
    dismiss,
  };
}
