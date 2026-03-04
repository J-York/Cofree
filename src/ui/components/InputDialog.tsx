/**
 * Cofree - AI Programming Cafe
 * File: src/ui/components/InputDialog.tsx
 * Description: A modal dialog for text input, replacing window.prompt for cross-platform compatibility.
 */

import { useEffect, useRef, useState, type ReactElement } from "react";

export interface InputDialogProps {
  open: boolean;
  title: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function InputDialog({
  open,
  title,
  placeholder,
  defaultValue = "",
  confirmLabel = "确认",
  cancelLabel = "取消",
  onConfirm,
  onCancel,
}: InputDialogProps): ReactElement | null {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setValue(defaultValue);
      // Focus input after dialog opens
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, defaultValue]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onConfirm(value);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, value, onConfirm, onCancel]);

  if (!open) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) {
      onCancel();
    }
  };

  return (
    <div
      ref={backdropRef}
      className="input-dialog-backdrop"
      onClick={handleBackdropClick}
    >
      <div className="input-dialog">
        <h3 className="input-dialog-title">{title}</h3>
        <textarea
          ref={inputRef}
          className="input-dialog-textarea"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          rows={3}
        />
        <div className="input-dialog-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => onConfirm(value)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
