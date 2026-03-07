import {
  getChatSessionId,
  resetChatSessionId,
} from "../../../orchestrator/checkpointStore";
import { resetHitlContinuationMemory } from "../../../orchestrator/hitlContinuationController";

export function resetChatSessionState(): string {
  const previousSessionId = getChatSessionId();
  resetChatSessionId();
  resetHitlContinuationMemory(previousSessionId);
  const nextSessionId = getChatSessionId();
  resetHitlContinuationMemory(nextSessionId);
  return nextSessionId;
}
