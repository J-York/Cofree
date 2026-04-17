import { useCallback, useRef } from "react";
import { CHAT_AUTO_SCROLL_THRESHOLD_PX } from "../constants";

/**
 * Owns the thread-scroll state (refs + small helpers) so that ChatPage can
 * stay focused on orchestration. Extracted from ChatPage.tsx (B1.7.2, see
 * docs/REFACTOR_PLAN.md).
 */
export function useThreadAutoScroll() {
  const threadRef = useRef<HTMLDivElement | null>(null);
  const contextAnchorRef = useRef<HTMLDivElement | null>(null);
  const shouldStickThreadToBottomRef = useRef(true);
  const forceThreadScrollRef = useRef(true);

  const isThreadNearBottom = useCallback(
    (thread: HTMLDivElement): boolean => {
      const distanceFromBottom =
        thread.scrollHeight - thread.scrollTop - thread.clientHeight;
      return distanceFromBottom <= CHAT_AUTO_SCROLL_THRESHOLD_PX;
    },
    [],
  );

  const syncThreadAutoScrollState = useCallback((): void => {
    const thread = threadRef.current;
    if (!thread) {
      return;
    }
    shouldStickThreadToBottomRef.current = isThreadNearBottom(thread);
  }, [isThreadNearBottom]);

  const scrollThreadToBottom = useCallback((): void => {
    const thread = threadRef.current;
    if (!thread) {
      return;
    }
    thread.scrollTop = thread.scrollHeight;
    shouldStickThreadToBottomRef.current = true;
    forceThreadScrollRef.current = false;
  }, []);

  const requestThreadScrollToBottom = useCallback((): void => {
    shouldStickThreadToBottomRef.current = true;
    forceThreadScrollRef.current = true;
  }, []);

  const handleThreadScroll = useCallback((): void => {
    syncThreadAutoScrollState();
  }, [syncThreadAutoScrollState]);

  return {
    threadRef,
    contextAnchorRef,
    shouldStickThreadToBottomRef,
    forceThreadScrollRef,
    isThreadNearBottom,
    syncThreadAutoScrollState,
    scrollThreadToBottom,
    requestThreadScrollToBottom,
    handleThreadScroll,
  };
}
