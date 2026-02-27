/**
 * Cofree - AI Programming Cafe
 * File: src/ui/pages/ChatPage.tsx
 * Milestone: 2
 * Task: 2.1
 * Status: Completed
 * Owner: Codex-GPT-5
 * Last Modified: 2026-02-27
 * Description: Streaming chat page that builds a pending-only orchestration plan.
 */

import { type ReactElement, useEffect, useRef, useState } from "react";
import { DEFAULT_AGENTS } from "../../agents/defaultAgents";
import { isLocalProvider } from "../../lib/litellm";
import type { AppSettings } from "../../lib/settingsStore";
import { runPlanningSession } from "../../orchestrator/planningService";
import type { OrchestrationPlan } from "../../orchestrator/types";

interface ChatPageProps {
  settings: AppSettings;
}

export function ChatPage({ settings }: ChatPageProps): ReactElement {
  const [prompt, setPrompt] = useState("给设置页补一个 API Key 持久化能力");
  const [assistantReply, setAssistantReply] = useState<string>("");
  const [plan, setPlan] = useState<OrchestrationPlan | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [sessionNote, setSessionNote] = useState<string>("等待点单。");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const localOnlyBlocked = !settings.allowCloudModels && !isLocalProvider(settings.provider);

  const handleCancel = (): void => {
    abortControllerRef.current?.abort();
  };

  useEffect(
    () => () => {
      abortControllerRef.current?.abort();
    },
    []
  );

  const handleSubmit = async (): Promise<void> => {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt || isStreaming) {
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsStreaming(true);
    setAssistantReply("");
    setPlan(null);
    setErrorMessage("");
    setSessionNote("服务员正在流式回复...");

    try {
      const result = await runPlanningSession({
        prompt: normalizedPrompt,
        settings,
        signal: controller.signal,
        onAssistantChunk: (chunk) => {
          setAssistantReply((previous) => `${previous}${chunk}`);
        }
      });

      setAssistantReply(result.assistantReply);
      setPlan(result.plan);
      setSessionNote("规划完成：动作均为 Pending，未执行。");
    } catch (error) {
      if (controller.signal.aborted) {
        setSessionNote("已取消本次点单。");
        return;
      }

      const message =
        error instanceof Error ? error.message : "请求失败，请检查网络与 LiteLLM 配置后重试。";
      setErrorMessage(message);
      setSessionNote("规划失败。");
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setIsStreaming(false);
    }
  };

  return (
    <div className="page-stack">
      <article className="panel-card">
        <h2>点单区</h2>
        <p className="status-note">
          Milestone 2：先流式回复，再产出结构化计划；所有敏感动作仅 Pending 展示，不执行。
        </p>
        {localOnlyBlocked ? (
          <p className="status-error">
            Local-only 已开启，当前 provider 不是本地模型。请到设置页切换到 Ollama。
          </p>
        ) : null}
        <textarea
          className="textarea"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="描述你希望 Cofree 执行的任务"
        />
        <div className="actions">
          <button
            className="button"
            disabled={isStreaming || !prompt.trim() || localOnlyBlocked}
            onClick={() => {
              void handleSubmit();
            }}
            type="button"
          >
            {isStreaming ? "规划中..." : "发送点单"}
          </button>
          <button
            className="button secondary"
            disabled={!isStreaming}
            onClick={handleCancel}
            type="button"
          >
            取消
          </button>
        </div>
        <p className="status-note">{sessionNote}</p>
        {errorMessage ? <p className="status-error">{errorMessage}</p> : null}
      </article>

      <article className="panel-card">
        <h3>服务员流式回复</h3>
        <pre className="stream-output">
          {assistantReply || (isStreaming ? "正在等待首个 token..." : "尚未开始会话。")}
        </pre>
      </article>

      <article className="panel-card">
        <h3>结构化计划</h3>
        {plan ? (
          <>
            <p className="status-note">State: {plan.state}</p>
            <p className="status-note">Prompt: {plan.prompt}</p>
            <ol>
              {plan.steps.map((step) => (
                <li key={step.id} className="plan-item">
                  {step.summary} ({step.owner})
                </li>
              ))}
            </ol>
            <p className="status-note">待审批动作（不执行）：</p>
            <ul className="action-list">
              {plan.proposedActions.map((action) => (
                <li key={action.id} className="action-item">
                  <span>{action.type}: {action.description}</span>
                  <span className="pending-pill">
                    {action.status.toUpperCase()} / {action.executed ? "Executed" : "Not Executed"}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="status-note">发送点单后会生成 `OrchestrationPlan`。</p>
        )}
      </article>

      <article className="panel-card">
        <h3>默认专家团队</h3>
        <ul>
          {DEFAULT_AGENTS.map((agent) => (
            <li key={agent.role}>
              {agent.displayName}: {agent.promptIntent}
            </li>
          ))}
        </ul>
      </article>
    </div>
  );
}
