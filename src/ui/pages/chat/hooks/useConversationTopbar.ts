import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ChatMessageRecord } from "../../../../lib/chatHistoryStore";
import type { OrchestrationPlan } from "../../../../orchestrator/types";
import {
  applyTopbarActionAvailability,
  findLatestAskUserAnchorMessageId,
  findLatestRestoreAnchorMessageId,
} from "../chatPageHelpers";
import { type ConversationTopbarAction } from "../ConversationTopbar";
import {
  focusTopbarTarget,
  resolveTopbarTargetElement,
  scrollThreadTargetIntoView,
} from "../conversationTopbarDom";
import {
  resolveConversationTopbarTarget,
  type ConversationTopbarTarget,
} from "../conversationTopbarNavigation";
import { deriveConversationTopbarState } from "../conversationTopbarState";
import type { LiveToolCall } from "../types";

interface UseConversationTopbarOptions {
  assistantDisplayName: string;
  activeConversationIdentity: string;
  messages: ChatMessageRecord[];
  visibleMessages: ChatMessageRecord[];
  lastVisibleMessage: ChatMessageRecord | undefined;
  activePlan: OrchestrationPlan | null;
  isStreaming: boolean;
  liveToolCalls: LiveToolCall[];
  hasAskUserPending: boolean;
  hasRestoreNotice: boolean;
  sessionNote: string;
  threadRef: MutableRefObject<HTMLDivElement | null>;
  contextAnchorRef: MutableRefObject<HTMLDivElement | null>;
}

/**
 * Owns topbar-related state (expandedPlan*) + memoized topbar derivation +
 * navigation/action handlers. Extracted from ChatPage.tsx (B1.7.6a, see
 * docs/REFACTOR_PLAN.md).
 */
export function useConversationTopbar(options: UseConversationTopbarOptions): {
  expandedPlanMessageId: string | null;
  expandedPlanActionId: string | null;
  expandedPlanRequestKey: number;
  setExpandedPlanMessageId: Dispatch<SetStateAction<string | null>>;
  setExpandedPlanActionId: Dispatch<SetStateAction<string | null>>;
  setExpandedPlanRequestKey: Dispatch<SetStateAction<number>>;
  askUserAnchorMessageId: string | null;
  restoreAnchorMessageId: string | null;
  topbarState: ReturnType<typeof deriveConversationTopbarState>;
  navigateTopbarTarget: (
    target: ConversationTopbarTarget,
    waitForExpansion?: boolean,
  ) => void;
  handleTopbarAction: (action: ConversationTopbarAction) => void;
} {
  const {
    assistantDisplayName,
    activeConversationIdentity,
    messages,
    visibleMessages,
    lastVisibleMessage,
    activePlan,
    isStreaming,
    liveToolCalls,
    hasAskUserPending,
    hasRestoreNotice,
    sessionNote,
    threadRef,
    contextAnchorRef,
  } = options;

  const [expandedPlanMessageId, setExpandedPlanMessageId] = useState<
    string | null
  >(null);
  const [expandedPlanActionId, setExpandedPlanActionId] = useState<
    string | null
  >(null);
  const [expandedPlanRequestKey, setExpandedPlanRequestKey] = useState(0);

  const askUserAnchorMessageId = useMemo(
    () =>
      findLatestAskUserAnchorMessageId({
        messages,
        lastVisibleMessage,
        isStreaming,
        liveToolCalls,
        hasAskUserPending,
      }),
    [
      hasAskUserPending,
      isStreaming,
      lastVisibleMessage,
      liveToolCalls,
      messages,
    ],
  );

  const restoreAnchorMessageId = useMemo(
    () => findLatestRestoreAnchorMessageId(visibleMessages, hasRestoreNotice),
    [hasRestoreNotice, visibleMessages],
  );

  const derivedTopbarState = useMemo(
    () =>
      deriveConversationTopbarState({
        agentLabel: assistantDisplayName,
        isStreaming,
        liveToolCalls,
        activePlan,
        hasAskUserPending,
        hasRestoreNotice,
        sessionNote,
      }),
    [
      activeConversationIdentity,
      activePlan,
      assistantDisplayName,
      hasAskUserPending,
      hasRestoreNotice,
      isStreaming,
      liveToolCalls,
      sessionNote,
    ],
  );

  const topbarTargets = useMemo(() => {
    const targets = new Map<
      ConversationTopbarAction,
      ConversationTopbarTarget | null
    >();

    for (const badge of derivedTopbarState.badges) {
      if (!badge.action || targets.has(badge.action)) {
        continue;
      }
      targets.set(
        badge.action,
        resolveConversationTopbarTarget({
          action: badge.action,
          messages,
          activePlan,
          liveToolCalls,
          hasAskUserPending,
          askUserAnchorMessageId,
          hasRestoreNotice,
          restoreAnchorMessageId,
          sessionNote,
        }),
      );
    }

    if (derivedTopbarState.progress.visible) {
      targets.set(
        "progress",
        resolveConversationTopbarTarget({
          action: "progress",
          messages,
          activePlan,
          liveToolCalls,
          hasAskUserPending,
          askUserAnchorMessageId,
          hasRestoreNotice,
          restoreAnchorMessageId,
          sessionNote,
        }),
      );
    }

    if (derivedTopbarState.attention?.ctaAction) {
      targets.set(
        derivedTopbarState.attention.ctaAction,
        resolveConversationTopbarTarget({
          action: derivedTopbarState.attention.ctaAction,
          messages,
          activePlan,
          liveToolCalls,
          hasAskUserPending,
          askUserAnchorMessageId,
          hasRestoreNotice,
          restoreAnchorMessageId,
          sessionNote,
        }),
      );
    }

    return targets;
  }, [
    activeConversationIdentity,
    activePlan,
    askUserAnchorMessageId,
    derivedTopbarState,
    hasAskUserPending,
    hasRestoreNotice,
    liveToolCalls,
    messages,
    restoreAnchorMessageId,
    sessionNote,
  ]);

  const topbarState = useMemo(
    () => applyTopbarActionAvailability(derivedTopbarState, topbarTargets),
    [derivedTopbarState, topbarTargets],
  );

  useEffect(() => {
    setExpandedPlanMessageId(null);
    setExpandedPlanActionId(null);
    setExpandedPlanRequestKey(0);
  }, [activeConversationIdentity]);

  const navigateTopbarTarget = useCallback(
    (target: ConversationTopbarTarget, waitForExpansion = false): void => {
      const runNavigation = () => {
        const resolved = resolveTopbarTargetElement({
          thread: threadRef.current,
          contextAnchor: contextAnchorRef.current,
          target,
        });
        if (!resolved) {
          return;
        }

        if (threadRef.current && threadRef.current.contains(resolved)) {
          scrollThreadTargetIntoView(threadRef.current, resolved);
        } else {
          resolved.scrollIntoView?.({ block: "nearest" });
        }
        focusTopbarTarget(resolved);
      };

      window.requestAnimationFrame(() => {
        if (waitForExpansion) {
          window.requestAnimationFrame(runNavigation);
          return;
        }
        runNavigation();
      });
    },
    [contextAnchorRef, threadRef],
  );

  const handleTopbarAction = useCallback(
    (action: ConversationTopbarAction): void => {
      const target = topbarTargets.get(action) ?? null;
      if (!target) {
        return;
      }

      const shouldExpandPlan =
        Boolean(target.messageId) &&
        (target.anchor === "approval" ||
          target.anchor === "plan" ||
          target.anchor === "blocked_output");
      if (shouldExpandPlan) {
        setExpandedPlanMessageId(target.messageId ?? null);
        setExpandedPlanActionId(target.actionId ?? null);
        setExpandedPlanRequestKey((current) => current + 1);
      }

      navigateTopbarTarget(target, shouldExpandPlan);
    },
    [navigateTopbarTarget, topbarTargets],
  );

  return {
    expandedPlanMessageId,
    expandedPlanActionId,
    expandedPlanRequestKey,
    setExpandedPlanMessageId,
    setExpandedPlanActionId,
    setExpandedPlanRequestKey,
    askUserAnchorMessageId,
    restoreAnchorMessageId,
    topbarState,
    navigateTopbarTarget,
    handleTopbarAction,
  };
}
