// src/dashboard/components/sidebar.jsx
import { useState, useEffect, useCallback } from 'react';
import {
  IconSignals, IconToday, IconInbox, IconDashboard, IconProjects,
  IconQueues, IconShelly, IconSettings, IconSidebar, IconOps
} from './icons';

// Flat nav. Order = priority. Divider separates daily-use from setup.
const PRIMARY = [
  { id: 'signals',  label: 'Signals', icon: IconSignals },
  { id: 'today',    label: 'Today',   icon: IconToday   },
  { id: 'captures', label: 'Inbox',   icon: IconInbox, badgeKey: 'pending' },
];
const SECONDARY = [
  { id: 'dashboard', label: 'Dashboard', icon: IconDashboard },
  { id: 'queues',    label: 'Queues',    icon: IconQueues   },
  { id: 'shelly',    label: 'Shelly',    icon: IconShelly   },
  { id: 'ops',       label: 'Ops',       icon: IconOps      },
];
const TERTIARY = [
  { id: 'projects', label: 'Projects', icon: IconProjects },
  { id: 'settings', label: 'Settings', icon: IconSettings },
];

function NavButton({ item, active, badge, expanded, onClick }) {
  const Icon = item.icon;
  return (
    <button
      onClick={onClick}
      className={`sidebar-item ${active ? 'active' : ''}`}
      title={!expanded ? item.label : undefined}
    >
      <span className="sidebar-icon">
        <Icon width={16} height={16} />
      </span>
      {expanded && (
        <>
          <span>{item.label}</span>
          {badge != null && badge > 0 && (
            <span className={`sidebar-badge ${item.badgeKey === 'pending' ? 'badge-attention' : ''}`}>
              {badge}
            </span>
          )}
        </>
      )}
      {!expanded && badge != null && badge > 0 && (
        <span className="absolute top-1 right-1.5 w-1.5 h-1.5 rounded-full bg-[var(--color-error)]" />
      )}
    </button>
  );
}

export function Sidebar({ activeTab, onTabChange, stats }) {
  const [expanded, setExpanded] = useState(() => {
    const stored = localStorage.getItem('devpanel_sidebar_expanded');
    return stored !== null ? stored === 'true' : true;
  });

  const toggle = useCallback(() => {
    setExpanded(prev => {
      const next = !prev;
      localStorage.setItem('devpanel_sidebar_expanded', String(next));
      return next;
    });
  }, []);

  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        toggle();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  return (
    <div className="sidebar h-full shrink-0" style={{ width: expanded ? 220 : 56 }}>
      {/* Collapse toggle row */}
      <div className="flex items-center h-11 px-3 shrink-0">
        <div className="flex-1" />
        <button
          onClick={toggle}
          className="text-[var(--color-foreground-faint)] hover:text-[var(--color-foreground)] transition-colors cursor-pointer p-1 rounded-md hover:bg-[var(--color-surface-2)]"
          title={expanded ? 'Collapse (⌘B)' : 'Expand (⌘B)'}
        >
          <IconSidebar width={14} height={14} />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto pt-1 pb-2">
        <div className="flex flex-col gap-0.5">
          {PRIMARY.map(item => (
            <NavButton
              key={item.id}
              item={item}
              active={activeTab === item.id}
              badge={item.badgeKey ? stats?.[item.badgeKey] : null}
              expanded={expanded}
              onClick={() => onTabChange(item.id)}
            />
          ))}
        </div>

        <div className="sidebar-divider" />

        <div className="flex flex-col gap-0.5">
          {SECONDARY.map(item => (
            <NavButton
              key={item.id}
              item={item}
              active={activeTab === item.id}
              badge={null}
              expanded={expanded}
              onClick={() => onTabChange(item.id)}
            />
          ))}
        </div>

        <div className="sidebar-divider" />

        <div className="flex flex-col gap-0.5">
          {TERTIARY.map(item => (
            <NavButton
              key={item.id}
              item={item}
              active={activeTab === item.id}
              badge={null}
              expanded={expanded}
              onClick={() => onTabChange(item.id)}
            />
          ))}
        </div>
      </nav>
    </div>
  );
}
