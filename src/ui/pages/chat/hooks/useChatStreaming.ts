import { useEffect, useRef, useState } from "react";
import type { BackgroundStreamState } from "../types";

/**
 * Owns the streaming lifecycle state shared between foreground rendering and
 * multi-conversation background streams.
 *
 * Extracted from ChatPage.tsx (B1.2, see docs/REFACTOR_PLAN.md). Variable names
 * intentionally mirror ChatPage's originals to keep the call-site diff minimal.
 */
export function useChatStreaming() {
  const [isStreaming, setIsStreaming] = useState<boolean>(false);

  // Current foreground controller (single-slot) — used for synchronous abort()
  // when the user switches conversations or hits stop.
  const abortControllerRef = useRef<AbortController | null>(null);

  // Per-conversation controllers — a stream started in conversation A must be
  // abortable even after the user switches to B.
  const abortControllersRef = useRef(new Map<string, AbortController>());

  // Per-conversation background stream snapshots — retained while the user
  // views a different conversation, then handed back on switch.
  const backgroundStreamsRef = useRef(new Map<string, BackgroundStreamState>());

  // On unmount: abort any still-running controllers.
  useEffect(
    () => () => {
      for (const ctrl of abortControllersRef.current.values()) {
        ctrl.abort();
      }
    },
    [],
  );

  return {
    isStreaming,
    setIsStreaming,
    abortControllerRef,
    abortControllersRef,
    backgroundStreamsRef,
  };
}
