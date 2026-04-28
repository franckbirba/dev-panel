// src/dashboard/components/icons.jsx
// Lucide-style SVG icon set — 24×24, 1.5px stroke
// Each icon is a named export for tree-shaking

const defaults = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' };
const I = (paths) => (props) => <svg {...defaults} {...props}>{paths}</svg>;

// ── Navigation ──────────────────────────────────────────

export const IconSignals = I(<>
  <path d="M2 20h.01" /><path d="M7 20v-4" /><path d="M12 20v-8" /><path d="M17 20V8" /><path d="M22 4v16" />
</>);

export const IconToday = I(<>
  <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
</>);

export const IconInbox = I(<>
  <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
  <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />
</>);

export const IconDashboard = I(<>
  <rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" />
  <rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" />
</>);

export const IconProjects = I(<>
  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
</>);

export const IconQueues = I(<>
  <path d="M16 3h5v5" /><path d="M8 3H3v5" /><path d="M12 22v-8.3a4 4 0 00-1.172-2.872L3 3" />
  <path d="M15 9l6-6" />
</>);

export const IconShelly = I(<>
  <path d="M12 8V4H8" /><rect x="8" y="8" width="8" height="12" rx="2" />
  <path d="M11 14h2" /><path d="M12 2v2" /><path d="M8 20H6a2 2 0 01-2-2v-2" /><path d="M16 20h2a2 2 0 002-2v-2" />
</>);

export const IconChain = I(<>
  <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
  <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
</>);

export const IconAgents = I(<>
  <circle cx="12" cy="8" r="3" />
  <circle cx="5" cy="17" r="2.5" />
  <circle cx="19" cy="17" r="2.5" />
  <path d="M12 11v2" /><path d="M10 14l-3 1.5" /><path d="M14 14l3 1.5" />
</>);

export const IconOps = I(<>
  <path d="M12 2v4" /><path d="M12 18v4" /><path d="M4.93 4.93l2.83 2.83" /><path d="M16.24 16.24l2.83 2.83" />
  <path d="M2 12h4" /><path d="M18 12h4" /><path d="M4.93 19.07l2.83-2.83" /><path d="M16.24 7.76l2.83-2.83" />
</>);

export const IconSettings = I(<>
  <circle cx="12" cy="12" r="3" />
  <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
</>);

// ── Signal types ────────────────────────────────────────

export const IconExhausted = I(<>
  <circle cx="12" cy="12" r="10" /><path d="M15 9l-6 6" /><path d="M9 9l6 6" />
</>);

export const IconNeedsInput = I(<>
  <circle cx="12" cy="12" r="10" /><path d="M12 16v.01" /><path d="M12 8v4" />
</>);

export const IconRunning = I(<>
  <path d="M21 12a9 9 0 11-6.219-8.56" />
</>);

export const IconFinished = I(<>
  <circle cx="12" cy="12" r="10" /><path d="M9 12l2 2 4-4" />
</>);

export const IconFailed = I(<>
  <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
  <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
</>);

export const IconCapture = I(<>
  <circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="10" />
</>);

export const IconDeploy = I(<>
  <path d="M12 19V5" /><polyline points="5 12 12 5 19 12" />
</>);

export const IconDeployFailed = I(<>
  <path d="M12 5v14" /><polyline points="19 12 12 19 5 12" />
</>);

export const IconTicket = I(<>
  <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18" /><path d="M7 15h4" />
</>);

// ── Actions ─────────────────────────────────────────────

export const IconSearch = I(<>
  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
</>);

export const IconPlus = I(<>
  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
</>);

export const IconClose = I(<>
  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
</>);

export const IconChevronDown = I(<>
  <polyline points="6 9 12 15 18 9" />
</>);

export const IconChevronRight = I(<>
  <polyline points="9 18 15 12 9 6" />
</>);

export const IconArrowLeft = I(<>
  <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
</>);

export const IconSend = I(<>
  <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
</>);

export const IconRefresh = I(<>
  <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
  <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
</>);

export const IconCamera = I(<>
  <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
  <circle cx="12" cy="13" r="4" />
</>);

export const IconPin = I(<>
  <line x1="12" y1="17" x2="12" y2="22" /><path d="M5 17h14v-1.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V6h1V3H8v3h1v4.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24z" />
</>);

export const IconSidebar = I(<>
  <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
</>);

// ── Priority dots (filled circles) ─────────────────────

export const IconPriorityNow = (props) => (
  <svg width="14" height="14" viewBox="0 0 14 14" {...props}>
    <circle cx="7" cy="7" r="5" fill="currentColor" opacity="0.2" />
    <circle cx="7" cy="7" r="3" fill="currentColor" />
  </svg>
);

export const IconPriorityToday = (props) => (
  <svg width="14" height="14" viewBox="0 0 14 14" {...props}>
    <circle cx="7" cy="7" r="5" fill="currentColor" opacity="0.15" />
    <circle cx="7" cy="7" r="3" fill="currentColor" />
  </svg>
);

export const IconPriorityLater = (props) => (
  <svg width="14" height="14" viewBox="0 0 14 14" {...props}>
    <circle cx="7" cy="7" r="3" fill="currentColor" opacity="0.3" />
  </svg>
);

// ── Logo ────────────────────────────────────────────────

export const IconLogo = (props) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" {...props}>
    <rect x="2" y="2" width="20" height="20" rx="6" fill="url(#logo-grad)" />
    <path d="M8 8h3v8H8V8zm5 0h3v8h-3V8z" fill="white" opacity="0.9" />
    <defs>
      <linearGradient id="logo-grad" x1="2" y1="2" x2="22" y2="22">
        <stop offset="0%" stopColor="#6366f1" />
        <stop offset="100%" stopColor="#34d399" />
      </linearGradient>
    </defs>
  </svg>
);

// Memory icon (brain/knowledge)
export const IconMemory = I(<>
  <path d="M12 2a7 7 0 0 0-4.6 12.3c.6.5 1 1.1 1.2 1.9l.4 1.8h6l.4-1.8c.2-.8.6-1.4 1.2-1.9A7 7 0 0 0 12 2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  <path d="M10 22h4M12 18v4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
</>);
