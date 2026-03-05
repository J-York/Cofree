import { useCallback, useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

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

const INITIAL: UpdateState = {
  status: "idle",
  version: "",
  body: "",
  progress: 0,
  error: "",
};

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const IS_DEV = import.meta.env.DEV;

export function useUpdater() {
  const [state, setState] = useState<UpdateState>(INITIAL);
  const updateRef = useRef<Update | null>(null);
  const dismissedVersion = useRef<string | null>(null);
  const checkingRef = useRef(false);

  const checkForUpdate = useCallback(async () => {
    if (IS_DEV) return;
    if (checkingRef.current) return;
    checkingRef.current = true;
    setState((s) => ({ ...s, status: "checking", error: "" }));

    try {
      const update = await check();
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
        setState(INITIAL);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/pubkey|signature|verify/i.test(msg)) {
        console.warn("[updater] Signature verification failed — is pubkey configured?", msg);
        setState(INITIAL);
      } else {
        setState((s) => ({ ...s, status: "error", error: msg }));
      }
    } finally {
      checkingRef.current = false;
    }
  }, []);

  const installUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;

    setState((s) => ({ ...s, status: "downloading", progress: 0 }));

    try {
      let totalLength = 0;
      let downloaded = 0;

      await update.downloadAndInstall((event) => {
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

      await relaunch();
    } catch (e) {
      setState((s) => ({
        ...s,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
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
    visible: state.status === "available" || state.status === "downloading" || state.status === "installing",
    checkForUpdate,
    installUpdate,
    dismiss,
  };
}
