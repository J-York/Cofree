/**
 * Cofree - AI Programming Cafe
 * File: src/ui/components/AskUserDialog.tsx
 * Description: Dialog component for Ask User tool interactions
 */

import { useEffect, useRef, useState, type ReactElement } from "react";
import type { AskUserRequest } from "../../orchestrator/askUserService";

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
  const [selectedOption, setSelectedOption] = useState<string>("");
  const [customResponse, setCustomResponse] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && request) {
      setSelectedOption("");
      setCustomResponse("");
      setIsSubmitting(false);
      // Focus input after dialog opens
      setTimeout(() => {
        if (request.options && request.options.length > 0) {
          // For option-based questions, don't auto-focus text input
          return;
        } else {
          inputRef.current?.focus();
        }
      }, 50);
    }
  }, [open, request]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, selectedOption, customResponse, isSubmitting]);

  if (!open || !request) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) {
      onCancel();
    }
  };

  const handleSubmit = () => {
    if (isSubmitting) return;

    const response = request.options && request.options.length > 0
      ? selectedOption
      : customResponse.trim();

    if (!response && request.required !== false) {
      // Required question with no answer
      inputRef.current?.focus();
      return;
    }

    setIsSubmitting(true);
    onResponse(response || "", !response);
  };

  const handleSkip = () => {
    if (request.required === false) {
      setIsSubmitting(true);
      onResponse("", true);
    }
  };

  const hasOptions = request.options && request.options.length > 0;
  const canSubmit = hasOptions 
    ? selectedOption.trim() !== ""
    : customResponse.trim() !== "" || request.required === false;
  const canSkip = request.required === false;

  return (
    <div
      ref={backdropRef}
      className="input-dialog-backdrop"
      onClick={handleBackdropClick}
    >
      <div className="input-dialog ask-user-dialog">
        <div className="ask-user-header">
          <h3 className="input-dialog-title">🤔 需要您的输入</h3>
          <div className="ask-user-meta">
            <span className="ask-user-timestamp">
              {new Date(request.timestamp).toLocaleTimeString()}
            </span>
          </div>
        </div>

        <div className="ask-user-content">
          {request.context && (
            <div className="ask-user-context">
              <div className="ask-user-context-label">背景信息：</div>
              <div className="ask-user-context-text">{request.context}</div>
            </div>
          )}

          <div className="ask-user-question">
            <div className="ask-user-question-text">{request.question}</div>
          </div>

          {hasOptions ? (
            <div className="ask-user-options">
              <div className="ask-user-options-label">请选择：</div>
              <div className="ask-user-options-grid">
                {request.options!.map((option, index) => (
                  <label
                    key={index}
                    className="ask-user-option-label"
                  >
                    <input
                      type="radio"
                      name="ask-user-option"
                      value={option}
                      checked={selectedOption === option}
                      onChange={(e) => setSelectedOption(e.target.value)}
                      disabled={isSubmitting}
                    />
                    <span className="ask-user-option-text">{option}</span>
                  </label>
                ))}
              </div>
            </div>
          ) : (
            <div className="ask-user-input">
              <textarea
                ref={inputRef}
                className="input-dialog-textarea"
                value={customResponse}
                onChange={(e) => setCustomResponse(e.target.value)}
                placeholder={
                  request.required === false 
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
      </div>
    </div>
  );
}
