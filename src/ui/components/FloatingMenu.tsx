import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";

interface FloatingMenuProps {
  trigger: ReactElement<{
    ref?: Ref<HTMLElement>;
    onClick?: (event: React.MouseEvent) => void;
    "aria-expanded"?: boolean;
    "aria-haspopup"?: boolean | "menu";
  }>;
  children: (close: () => void) => ReactNode;
  className?: string;
  align?: "start" | "end";
  offset?: number;
  edgeMargin?: number;
}

const DEFAULT_OFFSET = 4;
const DEFAULT_EDGE_MARGIN = 8;

export function FloatingMenu({
  trigger,
  children,
  className,
  align = "end",
  offset = DEFAULT_OFFSET,
  edgeMargin = DEFAULT_EDGE_MARGIN,
}: FloatingMenuProps): ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setIsOpen(false), []);

  const updatePosition = useCallback(() => {
    const triggerEl = triggerRef.current;
    const menuEl = menuRef.current;
    if (!triggerEl || !menuEl) return;

    const triggerRect = triggerEl.getBoundingClientRect();
    const menuRect = menuEl.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    let left =
      align === "end"
        ? triggerRect.right - menuRect.width
        : triggerRect.left;

    if (left + menuRect.width > viewportW - edgeMargin) {
      left = viewportW - menuRect.width - edgeMargin;
    }
    if (left < edgeMargin) {
      left = edgeMargin;
    }

    let top = triggerRect.bottom + offset;
    if (top + menuRect.height > viewportH - edgeMargin) {
      const flipped = triggerRect.top - menuRect.height - offset;
      if (flipped >= edgeMargin) {
        top = flipped;
      } else {
        top = Math.max(edgeMargin, viewportH - menuRect.height - edgeMargin);
      }
    }

    setPosition({
      position: "fixed",
      top: Math.round(top),
      left: Math.round(left),
      zIndex: 9999,
    });
  }, [align, offset, edgeMargin]);

  useLayoutEffect(() => {
    if (!isOpen) {
      setPosition(null);
      return;
    }
    updatePosition();
  }, [isOpen, updatePosition]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      close();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    const handleReposition = () => updatePosition();

    document.addEventListener("mousedown", handlePointerDown, true);
    document.addEventListener("keydown", handleKey);
    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
    };
  }, [isOpen, close, updatePosition]);

  if (!isValidElement(trigger)) {
    throw new Error("FloatingMenu: trigger must be a valid React element");
  }

  const originalProps = trigger.props as {
    onClick?: (event: React.MouseEvent) => void;
    ref?: Ref<HTMLElement>;
  };

  const triggerWithProps = cloneElement(trigger, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      const externalRef = originalProps.ref;
      if (typeof externalRef === "function") {
        externalRef(node);
      } else if (externalRef && typeof externalRef === "object") {
        (externalRef as { current: HTMLElement | null }).current = node;
      }
    },
    onClick: (event: React.MouseEvent) => {
      originalProps.onClick?.(event);
      if (event.defaultPrevented) return;
      setIsOpen((prev) => !prev);
    },
    "aria-expanded": isOpen,
    "aria-haspopup": "menu",
  });

  return (
    <>
      {triggerWithProps}
      {isOpen
        ? createPortal(
            <div
              ref={menuRef}
              className={className}
              role="menu"
              style={{
                ...position,
                visibility: position ? "visible" : "hidden",
              }}
            >
              {children(close)}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
