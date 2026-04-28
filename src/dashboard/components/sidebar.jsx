// src/dashboard/components/sidebar.jsx
import { useState, useEffect, useCallback } from 'react';
import {
  IconSignals, IconToday, IconInbox, IconProjects,
  IconQueues, IconShelly, IconSettings, IconSidebar, IconOps, IconAgents, IconChain,
  IconBrain, IconFleet
} from './icons';

// Flight-deck nav: 4 primary surfaces (Inbox · Fleet · Memory · Settings)
// own the verbs (decide / watch & steer / recall / configure). The legacy
// 10-tab grid lives in a demoted "Legacy" group below the divider during the
// transition; phase 5 of the migration plan removes it.
const PRIMARY = [
  { id: 'inbox',  label: 'Inbox',  icon: IconInbox, badgeKey: 'pending' },
  { id: 'fleet',  label: 'Fleet',  icon: IconFleet  },
  { id: 'memory', label: 'Memory', icon: IconBrain  },
];
const LEGACY = [
  { id: 'captures',   label: 'Captures',   icon: IconInbox    },
  { id: 'today',      label: 'Today',      icon: IconToday    },
  { id: 'signals',    label: 'Signals',    icon: IconSignals  },
  { id: 'agents',     label: 'Agents',     icon: IconAgents   },
  { id: 'work-items', label: 'Work items', icon: IconChain    },
  { id: 'queues',     label: 'Queues',     icon: IconQueues   },
  { id: 'shelly',     label: 'Shelly',     icon: IconShelly   },
  { id: 'ops',        label: 'Ops',        icon: IconOps      },
];
const TERTIARY = [
  { id: 'projects', label: 'Projects', icon: IconProjects },
  { id: 'settings', label: 'Settings', icon: IconSettings },
];

function NavButton({ item, active, badge, expanded, onClick, dimmed }) {
  const Icon = item.icon;
  return (
    <button
      onClick={onClick}
      className={`sidebar-item ${active ? 'active' : ''} ${dimmed ? 'opacity-60' : ''}`}
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

function GroupLabel({ label, expanded }) {
  if (!expanded) return null;
  return (
    <div className="px-3 pt-2 pb-1 text-[9px] uppercase tracking-widest text-[var(--color-foreground-faint)]">
      {label}
    </div>
  );
}

export function Sidebar({ activeTab, onTabChange, stats }) {
  const [expanded, setExpanded] = useState(() => {
    const stored = localStorage.getItem('devpanel_sidebar_expanded');
    return stored !== null ? stored === 'true' : true;
  });
  const [legacyOpen, setLegacyOpen] = useState(() => {
    return localStorage.getItem('devpanel_sidebar_legacy_open') === 'true';
  });

  const toggle = useCallback(() => {
    setExpanded(prev => {
      const next = !prev;
      localStorage.setItem('devpanel_sidebar_expanded', String(next));
      return next;
    });
  }, []);

  const toggleLegacy = useCallback(() => {
    setLegacyOpen(prev => {
      const next = !prev;
      localStorage.setItem('devpanel_sidebar_legacy_open', String(next));
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
        <GroupLabel label="Flight-deck" expanded={expanded} />
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
          {/* Settings is a primary surface but lives in the tertiary group
              alongside Projects since they're configuration verbs. We expose
              it directly here to honour the 4-surface mental model. */}
          <NavButton
            item={{ id: 'settings', label: 'Settings', icon: IconSettings }}
            active={activeTab === 'settings'}
            expanded={expanded}
            onClick={() => onTabChange('settings')}
          />
        </div>

        <div className="sidebar-divider" />

        {/* Legacy group — collapsed by default, demoted but reachable. */}
        {expanded ? (
          <button
            onClick={toggleLegacy}
            className="w-full flex items-center gap-2 px-3 pt-2 pb-1 text-[9px] uppercase tracking-widest text-[var(--color-foreground-faint)] hover:text-[var(--color-foreground-muted)] cursor-pointer"
          >
            <span className="flex-1 text-left">Legacy</span>
            <span>{legacyOpen ? '−' : '+'}</span>
          </button>
        ) : null}
        {(legacyOpen || !expanded) && (
          <div className="flex flex-col gap-0.5">
            {LEGACY.map(item => (
              <NavButton
                key={item.id}
                item={item}
                active={activeTab === item.id}
                badge={null}
                expanded={expanded}
                onClick={() => onTabChange(item.id)}
                dimmed
              />
            ))}
          </div>
        )}

        <div className="sidebar-divider" />

        <GroupLabel label="Manage" expanded={expanded} />
        <div className="flex flex-col gap-0.5">
          {TERTIARY.filter(it => it.id !== 'settings').map(item => (
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
