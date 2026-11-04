/** Minimal 14px stroke icons; no icon package is used. */
const S = 14;

const base = {
  width: S,
  height: S,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const ChevronDown = () => (
  <svg {...base} width={S} height={S}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);

export const ChevronRight = () => (
  <svg {...base} width={S} height={S}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);

export const Copy = () => (
  <svg {...base} width={S} height={S}>
    <rect x="9" y="9" width="11" height="11" rx="1.5" />
    <path d="M5 15V5a1 1 0 011-1h10" />
  </svg>
);

export const Database = () => (
  <svg {...base} width={S} height={S}>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
    <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </svg>
);

export const Edit = () => (
  <svg {...base} width={S} height={S}>
    <path d="M4 20h4l10-10-4-4L4 16v4z" />
    <path d="M14 6l4 4" />
  </svg>
);

export const Eye = () => (
  <svg {...base} width={S} height={S}>
    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
    <circle cx="12" cy="12" r="2.5" />
  </svg>
);

export const Filter = () => (
  <svg {...base} width={S} height={S}>
    <path d="M4 5h16l-6 7v6l-4 2v-8z" />
  </svg>
);

export const Folder = () => (
  <svg {...base} width={S} height={S}>
    <path d="M3 7a2 2 0 012-2h5l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
  </svg>
);

export const Group = () => (
  <svg {...base} width={S} height={S}>
    <path d="M4 18v-3a3 3 0 013-3h10a3 3 0 013 3v3" />
    <circle cx="8" cy="6" r="2.5" />
    <circle cx="16" cy="6" r="2.5" />
  </svg>
);

export const Key = () => (
  <svg {...base} width={S} height={S}>
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12l9-9M17 6l2 2M14 9l2 2" />
  </svg>
);

export const Lock = () => (
  <svg {...base} width={S} height={S}>
    <rect x="5" y="10" width="14" height="10" rx="2" />
    <path d="M8 10V7a4 4 0 018 0v3" />
  </svg>
);

export const Log = () => (
  <svg {...base} width={S} height={S}>
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <path d="M8 8h8M8 12h8M8 16h5" />
  </svg>
);

export const Plus = () => (
  <svg {...base} width={S} height={S}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const Refresh = () => (
  <svg {...base} width={S} height={S}>
    <path d="M20 12a8 8 0 10-2.3 5.6" />
    <path d="M20 5v7h-7" />
  </svg>
);

export const Search = () => (
  <svg {...base} width={S} height={S}>
    <circle cx="10" cy="10" r="6" />
    <path d="M15 15l5 5" />
  </svg>
);

export const Settings = () => (
  <svg {...base} width={S} height={S}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
  </svg>
);

export const Trash = () => (
  <svg {...base} width={S} height={S}>
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
  </svg>
);

export const Unload = () => (
  <svg {...base} width={S} height={S}>
    <path d="M12 3v10M8 9l4 4 4-4" />
    <path d="M5 17v2h14v-2" />
  </svg>
);

export const X = () => (
  <svg {...base} width={S} height={S}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
