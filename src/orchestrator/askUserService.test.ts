/**
 * Cofree - AI Programming Cafe
 * File: src/orchestrator/askUserService.test.ts
 * Description: Tests for Ask User service functionality
 */

import {
  createAskUserRequest,
  getPendingRequest,
  submitUserResponse,
  cancelPendingRequest,
  getResponseHistory,
  hasPendingRequest,
  getLastResponse,
  clearSessionState,
  waitForUserResponse,
  validateResponse,
  formatRequestForDisplay,
  type AskUserRequest,
} from "./askUserService";

describe("askUserService", () => {
  const testSessionId = "test-session-123";

  beforeEach(() => {
    // Clear state before each test
    clearSessionState(testSessionId);
  });

  afterEach(() => {
    // Clean up after each test
    clearSessionState(testSessionId);
  });

  describe("createAskUserRequest", () => {
    it("should create a request with basic parameters", () => {
      const requestId = createAskUserRequest(
        testSessionId,
        "What is your preferred database?"
      );

      expect(requestId).toBeDefined();
      expect(requestId).toMatch(/^ask_user_\d+_[a-z0-9]+$/);

      const pending = getPendingRequest(testSessionId);
      expect(pending).not.toBeNull();
      expect(pending!.id).toBe(requestId);
      expect(pending!.question).toBe("What is your preferred database?");
      expect(pending!.required).toBe(true);
      expect(pending!.sessionId).toBe(testSessionId);
      expect(pending!.context).toBeUndefined();
      expect(pending!.options).toBeUndefined();
    });

    it("should create a request with all parameters", () => {
      createAskUserRequest(
        testSessionId,
        "Choose database",
        "For the new project",
        ["PostgreSQL", "MongoDB", "SQLite"],
        false,
        false
      );

      const pending = getPendingRequest(testSessionId);
      expect(pending).not.toBeNull();
      expect(pending!.question).toBe("Choose database");
      expect(pending!.context).toBe("For the new project");
      expect(pending!.options).toEqual(["PostgreSQL", "MongoDB", "SQLite"]);
      expect(pending!.allowMultiple).toBe(false);
      expect(pending!.required).toBe(false);
    });

    it("should create a multi-select request", () => {
      createAskUserRequest(
        testSessionId,
        "Which features?",
        undefined,
        ["Auth", "Search", "Notifications"],
        true,
        true
      );

      const pending = getPendingRequest(testSessionId);
      expect(pending).not.toBeNull();
      expect(pending!.allowMultiple).toBe(true);
      expect(pending!.options).toEqual(["Auth", "Search", "Notifications"]);
    });

    it("should cancel existing request when creating new one", () => {
      createAskUserRequest(
        testSessionId,
        "First question"
      );

      const secondRequestId = createAskUserRequest(
        testSessionId,
        "Second question"
      );

      const pending = getPendingRequest(testSessionId);
      expect(pending!.id).toBe(secondRequestId);
      expect(pending!.question).toBe("Second question");
    });
  });

  describe("submitUserResponse", () => {
    it("should submit response successfully", () => {
      const requestId = createAskUserRequest(
        testSessionId,
        "What is your name?"
      );

      const success = submitUserResponse(testSessionId, requestId, "John Doe");

      expect(success).toBe(true);
      expect(hasPendingRequest(testSessionId)).toBe(false);

      const history = getResponseHistory(testSessionId);
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe(requestId);
      expect(history[0].response).toBe("John Doe");
      expect(history[0].skipped).toBe(false);
    });

    it("should handle skipped response", () => {
      const requestId = createAskUserRequest(
        testSessionId,
        "Optional question?",
        undefined,
        undefined,
        false,
        false
      );

      const success = submitUserResponse(testSessionId, requestId, "", true);

      expect(success).toBe(true);
      expect(hasPendingRequest(testSessionId)).toBe(false);

      const history = getResponseHistory(testSessionId);
      expect(history).toHaveLength(1);
      expect(history[0].response).toBe("");
      expect(history[0].skipped).toBe(true);
    });

    it("should fail for invalid request ID", () => {
      const success = submitUserResponse(testSessionId, "invalid-id", "response");

      expect(success).toBe(false);
    });

    it("should fail when no pending request", () => {
      const success = submitUserResponse(testSessionId, "some-id", "response");

      expect(success).toBe(false);
    });
  });

  describe("cancelPendingRequest", () => {
    it("should cancel pending request", () => {
      createAskUserRequest(testSessionId, "Test question");

      expect(hasPendingRequest(testSessionId)).toBe(true);

      const success = cancelPendingRequest(testSessionId);

      expect(success).toBe(true);
      expect(hasPendingRequest(testSessionId)).toBe(false);
    });

    it("should fail when no pending request", () => {
      const success = cancelPendingRequest(testSessionId);

      expect(success).toBe(false);
    });
  });

  describe("waitForUserResponse", () => {
    it("should reject stale waiter when a newer request supersedes it", async () => {
      const firstRequestId = createAskUserRequest(testSessionId, "First question");
      const firstWaiter = waitForUserResponse(firstRequestId);

      const secondRequestId = createAskUserRequest(testSessionId, "Second question");
      const secondWaiter = waitForUserResponse(secondRequestId);

      await expect(firstWaiter).rejects.toThrow("superseded");

      const accepted = submitUserResponse(testSessionId, secondRequestId, "Second answer");
      expect(accepted).toBe(true);

      await expect(secondWaiter).resolves.toMatchObject({
        id: secondRequestId,
        response: "Second answer",
        skipped: false,
      });
    });

    it("should reject waiter when session state is cleared", async () => {
      const requestId = createAskUserRequest(testSessionId, "Need input");
      const waiter = waitForUserResponse(requestId);

      clearSessionState(testSessionId);

      await expect(waiter).rejects.toThrow("session cleanup");
    });
  });

  describe("utility functions", () => {
    it("should get last response", () => {
      const requestId1 = createAskUserRequest(testSessionId, "Question 1");
      submitUserResponse(testSessionId, requestId1, "Answer 1");

      const requestId2 = createAskUserRequest(testSessionId, "Question 2");
      submitUserResponse(testSessionId, requestId2, "Answer 2");

      const lastResponse = getLastResponse(testSessionId);
      expect(lastResponse).not.toBeNull();
      expect(lastResponse!.response).toBe("Answer 2");
    });

    it("should return null when no last response", () => {
      const lastResponse = getLastResponse(testSessionId);
      expect(lastResponse).toBeNull();
    });
  });

  describe("validateResponse", () => {
    it("should accept any response when no options provided", () => {
      const result = validateResponse("any response");
      expect(result.valid).toBe(true);
      expect(result.normalizedValue).toBe("any response");
    });

    it("should validate against options exactly", () => {
      const options = ["Option A", "Option B", "Option C"];
      
      const result1 = validateResponse("Option A", options);
      expect(result1.valid).toBe(true);
      expect(result1.normalizedValue).toBe("Option A");

      const result2 = validateResponse("Option X", options);
      expect(result2.valid).toBe(false);
    });

    it("should validate case-insensitive", () => {
      const options = ["PostgreSQL", "MongoDB"];
      
      const result = validateResponse("postgresql", options);
      expect(result.valid).toBe(true);
      expect(result.normalizedValue).toBe("PostgreSQL");
    });

    it("should validate partial matches", () => {
      const options = ["PostgreSQL", "MongoDB", "SQLite"];
      
      const result1 = validateResponse("post", options);
      expect(result1.valid).toBe(true);
      expect(result1.normalizedValue).toBe("PostgreSQL");

      const result2 = validateResponse("SQL", options);
      expect(result2.valid).toBe(true);
      expect(result2.normalizedValue).toBe("SQLite");
    });
  });

  describe("formatRequestForDisplay", () => {
    it("should format basic request", () => {
      const request: AskUserRequest = {
        id: "test-id",
        question: "What is your preference?",
        required: true,
        timestamp: "2023-01-01T00:00:00Z",
      };

      const formatted = formatRequestForDisplay(request);
      expect(formatted.title).toBe("需要您的输入");
      expect(formatted.description).toBe("What is your preference?");
      expect(formatted.showOptions).toBe(false);
      expect(formatted.canSkip).toBe(false);
    });

    it("should format request with context", () => {
      const request: AskUserRequest = {
        id: "test-id",
        question: "What is your preference?",
        context: "This is for the new project setup",
        required: true,
        timestamp: "2023-01-01T00:00:00Z",
      };

      const formatted = formatRequestForDisplay(request);
      expect(formatted.description).toBe(
        "This is for the new project setup\n\nWhat is your preference?"
      );
    });

    it("should format request with options", () => {
      const request: AskUserRequest = {
        id: "test-id",
        question: "Choose database",
        options: ["PostgreSQL", "MongoDB"],
        required: true,
        timestamp: "2023-01-01T00:00:00Z",
      };

      const formatted = formatRequestForDisplay(request);
      expect(formatted.showOptions).toBe(true);
      expect(formatted.canSkip).toBe(false);
    });

    it("should allow skipping when not required", () => {
      const request: AskUserRequest = {
        id: "test-id",
        question: "Optional question",
        required: false,
        timestamp: "2023-01-01T00:00:00Z",
      };

      const formatted = formatRequestForDisplay(request);
      expect(formatted.canSkip).toBe(true);
    });
  });
});
