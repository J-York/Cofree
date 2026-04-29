import { describe, expect, it } from "vitest";
import type { AppSettings } from "../../../lib/settingsStore";
import {
  buildConversationDebugExportFileName,
  filterAuditRecordsForConversation,
  sanitizeSettingsForDebugExport,
} from "./debugExport";

const baseSettings: AppSettings = {
  apiKey: "secret-key",
  liteLLMBaseUrl: "http://localhost:4000",
  provider: "OpenAI",
  model: "openai/gpt-4o-mini",
  debugMode: true,
  allowCloudModels: true,
  maxSnippetLines: 200,
  sendRelativePathOnly: true,
  lastSavedAt: null,
  workspacePath: "/tmp/workspace",
  recentWorkspaces: ["/tmp/workspace"],
  toolPermissions: {
    list_files: "auto",
    read_file: "auto",
    grep: "auto",
    glob: "auto",
    git_status: "auto",
    git_diff: "auto",
    propose_file_edit: "ask",
    propose_shell: "ask",
    check_shell_job: "auto",
    diagnostics: "auto",
    fetch: "ask",
  },
  proxy: {
    mode: "http",
    url: "http://proxy.local",
    username: "user",
    password: "pass",
    noProxy: "localhost",
  },
  activeVendorId: "vendor-openai",
  activeModelId: "model-gpt4o-mini",
  vendors: [],
  managedModels: [],
  skills: [],
  snippets: [],
};

describe("debug export helpers", () => {
  it("removes secrets from settings snapshot", () => {
    expect(sanitizeSettingsForDebugExport(baseSettings)).toEqual({
      provider: "OpenAI",
      model: "openai/gpt-4o-mini",
      liteLLMBaseUrl: "http://localhost:4000",
      debugMode: true,
      allowCloudModels: true,
      maxSnippetLines: 200,
      sendRelativePathOnly: true,
      workspacePath: "/tmp/workspace",
      toolPermissions: baseSettings.toolPermissions,
      activeVendorId: "vendor-openai",
      activeModelId: "model-gpt4o-mini",
      proxy: {
        mode: "http",
        url: "http://proxy.local",
        noProxy: "localhost",
      },
    });
  });

  it("filters audit records to the current conversation window and workspace", () => {
    const filtered = filterAuditRecordsForConversation({
      conversation: {
        id: "conv-1",
        title: "调试会话",
        createdAt: "2026-03-10T10:00:00.000Z",
        updatedAt: "2026-03-10T10:30:00.000Z",
        messages: [],
      },
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "hello",
          createdAt: "2026-03-10T10:05:00.000Z",
          plan: null,
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "world",
          createdAt: "2026-03-10T10:25:00.000Z",
          plan: null,
        },
      ],
      exportedAt: "2026-03-10T10:40:00.000Z",
      workspacePath: "/tmp/workspace",
      llmAuditRecords: [
        {
          requestId: "req-inside",
          provider: "OpenAI",
          model: "gpt-4o-mini",
          timestamp: "2026-03-10T10:20:00.000Z",
          inputLength: 100,
          outputLength: 50,
        },
        {
          requestId: "req-outside",
          provider: "OpenAI",
          model: "gpt-4o-mini",
          timestamp: "2026-03-10T11:20:00.000Z",
          inputLength: 100,
          outputLength: 50,
        },
      ],
      actionAuditRecords: [
        {
          actionId: "action-inside",
          actionType: "shell",
          status: "success",
          startedAt: "2026-03-10T10:10:00.000Z",
          finishedAt: "2026-03-10T10:11:00.000Z",
          executor: "manual",
          reason: "ok",
          workspacePath: "/tmp/workspace",
          details: {},
        },
        {
          actionId: "action-wrong-workspace",
          actionType: "shell",
          status: "success",
          startedAt: "2026-03-10T10:10:00.000Z",
          finishedAt: "2026-03-10T10:11:00.000Z",
          executor: "manual",
          reason: "ok",
          workspacePath: "/tmp/other",
          details: {},
        },
      ],
    });

    expect(filtered.window).toEqual({
      startedAt: "2026-03-10T10:00:00.000Z",
      endedAt: "2026-03-10T10:40:00.000Z",
    });
    expect(filtered.llmRecords.map((record) => record.requestId)).toEqual(["req-inside"]);
    expect(filtered.actionRecords.map((record) => record.actionId)).toEqual([
      "action-inside",
    ]);
  });

  it("builds a filesystem-safe debug export filename", () => {
    const fileName = buildConversationDebugExportFileName({
      conversation: {
        id: "conv-1",
        title: "排查 / shell: timeout?",
        createdAt: "2026-03-10T10:00:00.000Z",
        updatedAt: "2026-03-10T10:30:00.000Z",
        messages: [],
      },
      activeConversationId: "conv-1",
      exportedAt: "2026-03-10T10:40:00.123Z",
    });

    expect(fileName).toBe(
      "cofree-debug-排查_-_shell-_timeout-2026-03-10T10-40-00Z.json",
    );
  });
});
