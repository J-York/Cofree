import { useEffect, useRef, type ReactElement, type ReactNode } from "react";

export interface BaseDialogProps {
  open: boolean;
  title?: ReactNode;
  onCancel: () => void;
  children: ReactNode;
  className?: string;
  onEnter?: () => void;
}

export function BaseDialog({
  open,
  title,
  onCancel,
  children,
  className = "",
  onEnter,
}: BaseDialogProps): ReactElement | null {
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
      } else if (e.key === "Enter" && !e.shiftKey && onEnter) {
        e.preventDefault();
        onEnter();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onCancel, onEnter]);

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
      <div className={`input-dialog ${className}`}>
        {title && <h3 className="input-dialog-title">{title}</h3>}
        {children}
      </div>
    </div>
  );
}
