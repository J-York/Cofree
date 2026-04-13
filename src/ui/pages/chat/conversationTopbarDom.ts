import type { ConversationTopbarTarget } from "./conversationTopbarNavigation";

const TOPBAR_FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function findMessageElement(root: ParentNode, messageId: string): HTMLElement | null {
  return (
    Array.from(root.querySelectorAll<HTMLElement>("[data-chat-message-id]")).find(
      (element) => element.dataset.chatMessageId === messageId,
    ) ?? null
  );
}

function findActionElement(root: HTMLElement, actionId: string): HTMLElement | null {
  if (root.dataset.topbarActionId === actionId) {
    return root;
  }
  return (
    Array.from(root.querySelectorAll<HTMLElement>("[data-topbar-action-id]")).find(
      (element) => element.dataset.topbarActionId === actionId,
    ) ?? null
  );
}

function findAnchoredElement(
  root: HTMLElement,
  anchor: ConversationTopbarTarget["anchor"],
): HTMLElement | null {
  if (root.dataset.topbarAnchor === anchor) {
    return root;
  }
  return root.querySelector<HTMLElement>(`[data-topbar-anchor="${anchor}"]`);
}

export function scrollThreadTargetIntoView(thread: HTMLDivElement, target: HTMLElement): void {
  const threadRect = thread.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const fallbackTop = target.offsetTop - thread.offsetTop - 24;
  const deltaTop = targetRect.top - threadRect.top - 24;
  const nextScrollTop =
    Number.isFinite(deltaTop) && deltaTop !== 0
      ? thread.scrollTop + deltaTop
      : fallbackTop;
  thread.scrollTop = Math.max(0, nextScrollTop);
}

export function focusTopbarTarget(target: HTMLElement): void {
  const focusable = target.matches(TOPBAR_FOCUSABLE_SELECTOR)
    ? target
    : target.querySelector<HTMLElement>(TOPBAR_FOCUSABLE_SELECTOR);
  const nextTarget = focusable ?? target;
  if (!nextTarget.hasAttribute("tabindex")) {
    nextTarget.tabIndex = -1;
  }
  nextTarget.focus();
}

export function resolveTopbarTargetElement(params: {
  thread: HTMLDivElement | null;
  contextAnchor: HTMLDivElement | null;
  target: ConversationTopbarTarget;
}): HTMLElement | null {
  const { thread, contextAnchor, target } = params;
  if (target.anchor === "context") {
    return contextAnchor;
  }
  if (!thread) {
    return null;
  }

  const scope = target.messageId ? findMessageElement(thread, target.messageId) ?? thread : thread;
  if (!scope) {
    return null;
  }

  if (target.actionId) {
    const actionElement = findActionElement(scope, target.actionId);
    if (actionElement) {
      return actionElement;
    }
  }

  if (target.anchor === "approval") {
    return findAnchoredElement(scope, "plan") ?? scope;
  }

  if (target.anchor === "blocked_output") {
    return (
      findAnchoredElement(scope, "blocked_output") ??
      findAnchoredElement(scope, "plan") ??
      scope
    );
  }

  return findAnchoredElement(scope, target.anchor) ?? scope;
}
