/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/askUserService.ts
 * Description: Ask User tool service for human-in-the-loop clarification
 */

// ---------------------------------------------------------------------------
// Simple logging for Ask User events (reusing audit infrastructure)
// ---------------------------------------------------------------------------

function logAskUserEvent(_event: string, _data: Record<string, unknown>): void {
  // Note: We could extend the audit system later for these events
  // For now, we'll just skip logging to avoid console dependency
  // eslint-disable-next-line no-console
  // console.log(`[AskUser] ${_event}:`, _data);
}

// ---------------------------------------------------------------------------
// Types for Ask User functionality
// ---------------------------------------------------------------------------

export enum AskUserError {
  INVALID_SESSION = 'INVALID_SESSION',
  REQUEST_NOT_FOUND = 'REQUEST_NOT_FOUND',
  ALREADY_RESPONDED = 'ALREADY_RESPONDED',
  INVALID_REQUEST_ID = 'INVALID_REQUEST_ID'
}

export interface AskUserRequest {
  id: string;
  sessionId?: string;
  question: string;
  context?: string;
  options?: string[];
  allowMultiple?: boolean;
  required?: boolean;
  timestamp: string;
}

export interface AskUserResponse {
  id: string;
  response: string;
  skipped: boolean;
  timestamp: string;
}

export interface AskUserState {
  pending: AskUserRequest | null;
  history: AskUserResponse[];
}

// ---------------------------------------------------------------------------
// State management with cleanup mechanism
// ---------------------------------------------------------------------------

const askUserState = new Map<string, AskUserState>();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const cleanupIntervalMs = 5 * 60 * 1000; // Check every 5 minutes

// Session timestamps for cleanup tracking
const sessionTimestamps = new Map<string, number>();

// Promise resolvers for async waiting
interface PendingResolver {
  resolve: (response: AskUserResponse) => void;
  reject: (reason: Error) => void;
}
const pendingResolvers = new Map<string, PendingResolver>();

// Periodic cleanup to prevent memory leaks
export const cleanupInterval = setInterval(() => {
  const now = Date.now();
  const sessionsToClean: string[] = [];
  
  for (const [sessionId, timestamp] of sessionTimestamps.entries()) {
    if (now - timestamp > SESSION_TIMEOUT_MS) {
      sessionsToClean.push(sessionId);
    }
  }
  
  sessionsToClean.forEach(sessionId => {
    clearState(sessionId);
  });
}, cleanupIntervalMs);

function getOrCreateState(sessionId: string): AskUserState {
  if (!askUserState.has(sessionId)) {
    askUserState.set(sessionId, {
      pending: null,
      history: [],
    });
  }
  // Update session timestamp for cleanup tracking
  sessionTimestamps.set(sessionId, Date.now());
  return askUserState.get(sessionId)!;
}

function clearState(sessionId: string): void {
  const state = askUserState.get(sessionId);
  if (state?.pending) {
    const requestId = state.pending.id;
    const resolver = pendingResolvers.get(requestId);
    if (resolver) {
      pendingResolvers.delete(requestId);
      resolver.reject(new Error("ask_user request cancelled by session cleanup"));
    }
  }
  askUserState.delete(sessionId);
  sessionTimestamps.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new ask user request and return the request ID.
 * This pauses the tool execution until the user responds.
 */
export function createAskUserRequest(
  sessionId: string,
  question: string,
  context?: string,
  options?: string[],
  allowMultiple: boolean = false,
  required: boolean = true,
): string {
  const state = getOrCreateState(sessionId);
  
  // If there's already a pending request, cancel it
  if (state.pending) {
    const previousRequestId = state.pending.id;
    logAskUserEvent("request_cancelled", {
      sessionId,
      requestId: previousRequestId,
      reason: "superseded_by_new_request",
    });
    const resolver = pendingResolvers.get(previousRequestId);
    if (resolver) {
      pendingResolvers.delete(previousRequestId);
      resolver.reject(new Error("ask_user request superseded by a newer request"));
    }
  }

  const requestId = `ask_user_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  const request: AskUserRequest = {
    id: requestId,
    sessionId,
    question,
    context,
    options,
    allowMultiple,
    required,
    timestamp: new Date().toISOString(),
  };

  state.pending = request;

  logAskUserEvent("request_created", {
    sessionId,
    requestId,
    question,
    hasContext: !!context,
    hasOptions: !!options?.length,
    allowMultiple,
    required,
  });

  return requestId;
}

/**
 * Get the current pending request for a session.
 */
export function getPendingRequest(sessionId: string): AskUserRequest | null {
  const state = askUserState.get(sessionId);
  return state?.pending ?? null;
}

/**
 * Submit a user response to a pending request.
 */
export function submitUserResponse(
  sessionId: string,
  requestId: string,
  response: string,
  skipped: boolean = false,
): boolean {
  const state = askUserState.get(sessionId);
  if (!state || !state.pending || state.pending.id !== requestId) {
    return false;
  }

  const userResponse: AskUserResponse = {
    id: requestId,
    response: skipped ? "" : response,
    skipped,
    timestamp: new Date().toISOString(),
  };

  state.history.push(userResponse);
  state.pending = null;

  logAskUserEvent("response_submitted", {
    sessionId,
    requestId,
    responseLength: response.length,
    skipped,
  });

  // Resolve the waiting promise if any
  const resolver = pendingResolvers.get(requestId);
  if (resolver) {
    pendingResolvers.delete(requestId);
    resolver.resolve(userResponse);
  }

  return true;
}

/**
 * Cancel a pending request (e.g., due to timeout or session end).
 */
export function cancelPendingRequest(sessionId: string): boolean {
  const state = askUserState.get(sessionId);
  if (!state || !state.pending) {
    return false;
  }

  const requestId = state.pending.id;
  state.pending = null;

  logAskUserEvent("request_cancelled", {
    sessionId,
    requestId,
    reason: "cancelled_by_system",
  });

  // Reject the waiting promise if any
  const resolver = pendingResolvers.get(requestId);
  if (resolver) {
    pendingResolvers.delete(requestId);
    resolver.reject(new Error("ask_user request cancelled by user"));
  }

  return true;
}

/**
 * Get the response history for a session.
 */
export function getResponseHistory(sessionId: string): AskUserResponse[] {
  const state = askUserState.get(sessionId);
  return state?.history ?? [];
}

/**
 * Clear all state for a session (call when session ends).
 */
export function clearSessionState(sessionId: string): void {
  clearState(sessionId);
  logAskUserEvent("session_cleared", { sessionId });
}

/**
 * Cleanup function to stop the cleanup interval (call when app shuts down).
 */
export function stopCleanupInterval(): void {
  clearInterval(cleanupInterval);
}

/**
 * Wait asynchronously for the user to respond to a pending request.
 * Resolves with the user's response, or rejects if cancelled / aborted.
 */
export function waitForUserResponse(
  requestId: string,
  signal?: AbortSignal,
): Promise<AskUserResponse> {
  return new Promise<AskUserResponse>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }

    const onAbort = () => {
      pendingResolvers.delete(requestId);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Aborted"));
    };

    pendingResolvers.set(requestId, {
      resolve: (response) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(response);
      },
      reject: (reason) => {
        signal?.removeEventListener("abort", onAbort);
        reject(reason);
      },
    });

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Check if a session has a pending request.
 */
export function hasPendingRequest(sessionId: string): boolean {
  const state = askUserState.get(sessionId);
  return state?.pending !== null;
}

/**
 * Get the most recent response for a session.
 */
export function getLastResponse(sessionId: string): AskUserResponse | null {
  const history = getResponseHistory(sessionId);
  return history.length > 0 ? history[history.length - 1] : null;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Format a request for display in the UI.
 */
export function formatRequestForDisplay(request: AskUserRequest): {
  title: string;
  description: string;
  showOptions: boolean;
  canSkip: boolean;
} {
  return {
    title: "需要您的输入",
    description: request.context 
      ? `${request.context}\n\n${request.question}`
      : request.question,
    showOptions: !!request.options && request.options.length > 0,
    canSkip: !request.required,
  };
}

/**
 * Validate a user response against options (if provided).
 */
export function validateResponse(
  response: string,
  options?: string[],
): { valid: boolean; normalizedValue?: string } {
  if (!options || options.length === 0) {
    return { valid: true, normalizedValue: response.trim() };
  }

  const trimmedResponse = response.trim();
  
  // Check exact match
  const exactMatch = options.find(option => option === trimmedResponse);
  if (exactMatch) {
    return { valid: true, normalizedValue: exactMatch };
  }

  // Check case-insensitive match
  const caseMatch = options.find(option => 
    option.toLowerCase() === trimmedResponse.toLowerCase()
  );
  if (caseMatch) {
    return { valid: true, normalizedValue: caseMatch };
  }

  // Check partial match (for convenience) - prioritize options that start with the input
  const startsWithMatch = options.find(option =>
    option.toLowerCase().startsWith(trimmedResponse.toLowerCase())
  );
  if (startsWithMatch) {
    return { valid: true, normalizedValue: startsWithMatch };
  }

  // Then check if any option contains the input
  const containsMatch = options.find(option =>
    option.toLowerCase().includes(trimmedResponse.toLowerCase())
  );
  if (containsMatch) {
    return { valid: true, normalizedValue: containsMatch };
  }

  // Finally check if the input contains any option
  const responseContainsMatch = options.find(option =>
    trimmedResponse.toLowerCase().includes(option.toLowerCase())
  );
  if (responseContainsMatch) {
    return { valid: true, normalizedValue: responseContainsMatch };
  }

  return { valid: false };
}
