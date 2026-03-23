/**
 * Cofree - AI Programming Cafe
 * File: src/ui/components/AskUserDialog.tsx
 * Description: Dialog component for Ask User tool interactions
 */

import { useEffect, useRef, useState, useCallback, type ReactElement } from "react";
import type { AskUserRequest } from "../../orchestrator/askUserService";
import { BaseDialog } from "./BaseDialog";

const OTHER_OPTION_SENTINEL = "__cofree_other__";

export interface AskUserDialogProps {
  open: boolean;
  request: AskUserRequest | null;
  onResponse: (response: string, skipped: boolean) => void;
  onCancel: () => void;
}

export function AskUserDialog({
  open,
  request,
  onResponse,
  onCancel,
}: AskUserDialogProps): ReactElement | null {
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(new Set());
  const [customResponse, setCustomResponse] = useState<string>("");
  const [otherText, setOtherText] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const otherInputRef = useRef<HTMLInputElement>(null);

  const hasOptions = !!(request?.options && request.options.length > 0);
  const isMultiple = !!(hasOptions && request?.allowMultiple);
  const otherSelected = selectedOptions.has(OTHER_OPTION_SENTINEL);

  useEffect(() => {
    if (open && request) {
      setSelectedOptions(new Set());
      setCustomResponse("");
      setOtherText("");
      setIsSubmitting(false);
      setTimeout(() => {
        if (hasOptions) return;
        inputRef.current?.focus();
      }, 50);
    }
  }, [open, request, hasOptions]);

  const buildResponse = useCallback((): string => {
    if (!hasOptions) return customResponse.trim();

    if (isMultiple) {
      const picked = Array.from(selectedOptions)
        .filter((v) => v !== OTHER_OPTION_SENTINEL)
        .slice();
      if (otherSelected && otherText.trim()) {
        picked.push(otherText.trim());
      }
      return JSON.stringify(picked);
    }

    // Single-select
    const [first] = selectedOptions;
    if (first === OTHER_OPTION_SENTINEL) return otherText.trim();
    return first ?? "";
  }, [hasOptions, isMultiple, selectedOptions, customResponse, otherSelected, otherText]);

  const canSubmit = (() => {
    if (!hasOptions) {
      return customResponse.trim() !== "" || request?.required === false;
    }
    if (selectedOptions.size === 0) return request?.required === false;
    if (otherSelected && selectedOptions.size === 1 && !otherText.trim()) {
      return request?.required === false;
    }
    return true;
  })();

  const handleSubmit = useCallback(() => {
    if (isSubmitting || !canSubmit) return;
    const response = buildResponse();
    setIsSubmitting(true);
    onResponse(response, !response);
  }, [isSubmitting, canSubmit, buildResponse, onResponse]);

  const handleEnter = useCallback(() => {
    handleSubmit();
  }, [handleSubmit]);

  const handleSkip = () => {
    if (request?.required === false) {
      setIsSubmitting(true);
      onResponse("", true);
    }
  };

  const toggleOption = (value: string) => {
    if (isMultiple) {
      setSelectedOptions((prev) => {
        const next = new Set(prev);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        return next;
      });
      if (value === OTHER_OPTION_SENTINEL) {
        setTimeout(() => otherInputRef.current?.focus(), 50);
      }
    } else {
      setSelectedOptions(new Set([value]));
      if (value === OTHER_OPTION_SENTINEL) {
        setTimeout(() => otherInputRef.current?.focus(), 50);
      }
    }
  };

  const canSkip = request?.required === false;

  return (
    <BaseDialog
      open={open}
      title={
        <>
          🤔 需要您的输入
          <div className="ask-user-meta">
            <span className="ask-user-timestamp">
              {request ? new Date(request.timestamp).toLocaleTimeString() : ""}
            </span>
          </div>
        </>
      }
      onCancel={onCancel}
      className="ask-user-dialog"
      onEnter={handleEnter}
    >
      <div className="ask-user-content">
        {request?.context && (
          <div className="ask-user-context">
            <div className="ask-user-context-label">背景信息：</div>
            <div className="ask-user-context-text">{request?.context}</div>
          </div>
        )}
        <div className="ask-user-question">
          <div className="ask-user-question-text">{request?.question}</div>
        </div>
        {hasOptions ? (
          <div className="ask-user-options">
            <div className="ask-user-options-label">
              {isMultiple ? "请选择（可多选）：" : "请选择："}
            </div>
            <div className="ask-user-options-grid">
              {request?.options?.map((option, index) => (
                <label key={index} className="ask-user-option-label">
                  <input
                    type={isMultiple ? "checkbox" : "radio"}
                    name="ask-user-option"
                    value={option}
                    checked={selectedOptions.has(option)}
                    onChange={() => toggleOption(option)}
                    disabled={isSubmitting}
                  />
                  <span className="ask-user-option-text">{option}</span>
                </label>
              ))}
              {/* "其他" option is always present when options exist */}
              <label className="ask-user-option-label ask-user-option-other">
                <input
                  type={isMultiple ? "checkbox" : "radio"}
                  name="ask-user-option"
                  value={OTHER_OPTION_SENTINEL}
                  checked={otherSelected}
                  onChange={() => toggleOption(OTHER_OPTION_SENTINEL)}
                  disabled={isSubmitting}
                />
                <span className="ask-user-option-text">其他</span>
              </label>
            </div>
            {otherSelected && (
              <div className="ask-user-other-input">
                <input
                  ref={otherInputRef}
                  type="text"
                  className="ask-user-other-textfield"
                  value={otherText}
                  onChange={(e) => setOtherText(e.target.value)}
                  placeholder="请输入您的答案..."
                  disabled={isSubmitting}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="ask-user-input">
            <textarea
              ref={inputRef}
              className="input-dialog-textarea"
              value={customResponse}
              onChange={(e) => setCustomResponse(e.target.value)}
              placeholder={
                request?.required === false
                  ? "请输入您的回答（可选）..."
                  : "请输入您的回答..."
              }
              rows={3}
              disabled={isSubmitting}
            />
          </div>
        )}
      </div>
      <div className="input-dialog-actions ask-user-actions">
        <div className="ask-user-actions-left">
          {canSkip && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={handleSkip}
              disabled={isSubmitting}
            >
              跳过
            </button>
          )}
        </div>
        <div className="ask-user-actions-right">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handleSubmit}
            disabled={!canSubmit || isSubmitting}
          >
            {isSubmitting ? "提交中..." : "确认"}
          </button>
        </div>
      </div>
    </BaseDialog>
  );
}
