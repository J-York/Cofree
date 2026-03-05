import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function defaults(props: IconProps, size = 16): SVGProps<SVGSVGElement> {
  const { size: s, ...rest } = props;
  const px = s ?? size;
  return {
    width: px,
    height: px,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    ...rest,
  };
}

export function IconChat(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M2 3h12v8H5l-3 3V3z" />
    </svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <svg {...defaults(props)} strokeWidth={1.4}>
      <path d="M6.6 1h2.8l.4 2.2a5.8 5.8 0 011.5.87l2.1-.78 1.1 1.92-1.7 1.38a5.8 5.8 0 010 1.78l1.7 1.38-1.1 1.92-2.1-.78a5.8 5.8 0 01-1.5.87L9.4 15H6.6l-.4-2.22a5.8 5.8 0 01-1.5-.87l-2.1.78-1.1-1.92 1.7-1.38a5.8 5.8 0 010-1.78L1.5 6.23l1.1-1.92 2.1.78a5.8 5.8 0 011.5-.87L6.6 1z" />
      <circle cx="8" cy="8" r="2.5" />
    </svg>
  );
}

export function IconTerminal(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M2 3h12v10H2zM5 7l2 2-2 2M9 11h2" />
    </svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l4 4" />
    </svg>
  );
}

export function IconFolder(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M2 4v9h12V6H8L6 4H2z" />
    </svg>
  );
}

export function IconEdit(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M11 2l3 3-8 8H3v-3l8-8z" />
    </svg>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M3 4h10M6 4V3h4v1M5 6v7h6V6" />
    </svg>
  );
}

export function IconX(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M3 8l4 4 6-8" />
    </svg>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

export function IconMinus(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M3 8h10" />
    </svg>
  );
}

export function IconMaximize(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <rect x="3" y="3" width="10" height="10" rx="1" />
    </svg>
  );
}

export function IconSidebar(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <rect x="2" y="2" width="12" height="12" rx="1" />
      <path d="M6 2v12" />
    </svg>
  );
}

export function IconSend(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M2 8l12-5-5 12-2-5-5-2z" />
    </svg>
  );
}

export function IconStop(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <rect x="4" y="4" width="8" height="8" rx="1" />
    </svg>
  );
}

export function IconBranch(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <circle cx="5" cy="4" r="1.5" />
      <circle cx="11" cy="4" r="1.5" />
      <circle cx="5" cy="12" r="1.5" />
      <path d="M5 5.5v5M11 5.5c0 3-6 3-6 5" />
    </svg>
  );
}

export function IconCode(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M5 4L1 8l4 4M11 4l4 4-4 4" />
    </svg>
  );
}

export function IconFile(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M4 2h5l3 3v9H4V2z" />
      <path d="M9 2v3h3" />
    </svg>
  );
}

export function IconWarning(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M8 2L1 14h14L8 2zM8 6v4M8 12h0" />
    </svg>
  );
}

export function IconSpinner(props: IconProps) {
  return (
    <svg {...defaults(props)} className={`icon-spin ${props.className ?? ""}`}>
      <path d="M8 2a6 6 0 105.3 3.2" />
    </svg>
  );
}

export function IconUser(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <circle cx="8" cy="5" r="3" />
      <path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6" />
    </svg>
  );
}

export function IconBot(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <rect x="3" y="5" width="10" height="8" rx="2" />
      <circle cx="6" cy="9" r="1" fill="currentColor" stroke="none" />
      <circle cx="10" cy="9" r="1" fill="currentColor" stroke="none" />
      <path d="M8 2v3M5 5V4M11 5V4" />
    </svg>
  );
}

export function IconComment(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M2 3h12v7H6l-4 3V3z" />
    </svg>
  );
}

export function IconExport(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M8 2v8M4 6l4-4 4 4M2 11v2h12v-2" />
    </svg>
  );
}

export function IconPanelBottom(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <rect x="2" y="2" width="12" height="12" rx="1" />
      <path d="M2 10h12" />
    </svg>
  );
}
