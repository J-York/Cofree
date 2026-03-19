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
    <svg {...defaults(props)}>
      <circle cx="8" cy="8" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" transform="scale(0.5) translate(4, 4)"/>
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
      <path d="M3 4h10M6 4V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2M5 4v9a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V4" />
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

export function IconSun(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 2v1M8 13v1M2 8h1M13 8h1M3.5 3.5l.7.7M11.8 11.8l.7.7M3.5 12.5l.7-.7M11.8 4.2l.7-.7" />
    </svg>
  );
}

export function IconMoon(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <path d="M12 3a6 6 0 1 0 0 10 7 7 0 0 1 0-10z" />
    </svg>
  );
}

export function IconMonitor(props: IconProps) {
  return (
    <svg {...defaults(props)}>
      <rect x="2" y="3" width="12" height="8" rx="1" />
      <path d="M5 14h6M8 11v3" />
    </svg>
  );
}
