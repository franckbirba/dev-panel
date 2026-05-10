import { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { CommandPalette } from "@/components/command-palette";
import { CaptureComposer } from "@/components/capture-composer";
import { DogfoodWidget } from "@/components/dogfood-widget";
import { buildCommands } from "@/lib/commands";
import { CommandDock } from "@/components/command-dock";
import { ProjectRibbon } from "@/components/project-ribbon";
import { PasteUrlModal } from "@/components/paste-url-modal";
import { SettingsView } from "@/views/settings-view";
import { QueuesView } from "@/views/queues-view";
import { ShellyView } from "@/views/shelly-view";
import { ProjectsView } from "@/views/projects-view";
import { TodayView } from "@/views/today-view";
import { CapturesView } from "@/views/captures-view";
import { SignalsView } from "@/views/signals-view";
import { OpsView } from "@/views/ops-view";
import { AgentsView } from "@/views/agents-view";
import { WorkItemsView } from "@/views/work-items-view";
import { InboxView } from "@/views/inbox-view";
import { FleetView } from "@/views/fleet-view";
import { FleetLiveView } from "@/views/fleet-live-view";
import { MemoryView } from "@/views/memory-view";
import { IconLogo } from "@/components/icons";
import {
  migrateLegacy, listLocalProjects, getCurrentProject, addOrUpdateProject,
  getAdminKey, hydrateFromSession
} from "@/lib/projects-store";

// Derive initial tab from URL
function getInitialTab() {
  const path = window.location.pathname;
  // Flight-deck primary surfaces (preferred)
  if (path.includes("/inbox"))      return "inbox";
  if (path.includes("/fleet"))      return "fleet";
  if (path.includes("/memory"))     return "memory";
  // Legacy tabs (still mountable during transition)
  if (path.includes("/queues"))     return "queues";
  if (path.includes("/shelly"))     return "shelly";
  if (path.includes("/agents"))     return "agents";
  if (path.includes("/work-items")) return "work-items";
  if (path.includes("/ops"))        return "ops";
  if (path.includes("/projects"))   return "projects";
  if (path.includes("/settings"))   return "settings";
  if (path.includes("/today"))      return "today";
  if (path.includes("/signals"))    return "signals";
  if (path.includes("/captures"))   return "captures";
  // Default landing: the typed Inbox.
  return "inbox";
}

function App() {
  // Migrate v1 storage on first mount, then read from v2.
  useEffect(() => { migrateLegacy(); }, []);

  const [activeTab, setActiveTab] = useState(getInitialTab);
  // currentProject snapshot — re-read on switch via projectVersion bump.
  const [projectVersion, setProjectVersion] = useState(0);
  const currentProject = getCurrentProject();
  const apiKey = currentProject?.api_key || "";
  const [sseConnected, setSseConnected] = useState(false);
  const [activities, setActivities] = useState([]);
  const [stats, setStats] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [queueHealth, setQueueHealth] = useState(null);
  // Status bar surfaces a single shelly badge (awake/down). Poll is cheap
  // (60s) and only kicks once apiKey is known. The full Shelly view owns
  // the 10s status poll for its own header.
  const [shellyStatus, setShellyStatus] = useState(null);
  const [capturesCount, setCapturesCount] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [showAddProject, setShowAddProject] = useState(false);
  const [globalCaptureOpen, setGlobalCaptureOpen] = useState(false);
  const sseRef = useRef(null);

  // Traefik enforces SSO before the SPA loads, so by the time we mount we
  // know the user is authenticated. Hydrate the project list (which the
  // server gates on X-Forwarded-User).
  useEffect(() => {
    hydrateFromSession("").then((n) => {
      if (n > 0) setProjectVersion((v) => v + 1);
    });
  }, []);

  // ⌘K opens the command palette globally
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(o => !o);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const apiUrl = window.location.origin;

  // Bump everything that depends on the active project when the user switches.
  const handleProjectSwitch = useCallback(() => {
    setProjectVersion(v => v + 1);
    setRefreshKey(k => k + 1);
    setActivities([]);
    setStats(null);
  }, []);

  function handleTabChange(tab) {
    setActiveTab(tab);
    // Update URL for bookmarking without full navigation
    const path = tab === "inbox" ? "/dashboard/inbox"
      : tab === "fleet" ? "/dashboard/fleet"
      : tab === "memory" ? "/dashboard/memory"
      : tab === "queues" ? "/dashboard/queues"
      : tab === "shelly" ? "/dashboard/shelly"
      : tab === "agents" ? "/dashboard/agents"
      : tab === "work-items" ? "/dashboard/work-items"
      : tab === "ops" ? "/dashboard/ops"
      : tab === "projects" ? "/dashboard/projects"
      : tab === "settings" ? "/dashboard/settings"
      : tab === "signals" ? "/dashboard/signals"
      : tab === "today" ? "/dashboard/today"
      : tab === "captures" ? "/dashboard/captures"
      : "/dashboard/inbox";
    window.history.replaceState(null, "", path);
  }

  async function handleApiKeySubmit(e) {
    e.preventDefault();
    const key = e.target.elements.apikey.value.trim();
    if (!key) return;
    // Resolve via /whoami so the project shows up in the switcher with a real
    // name. If the lookup fails (key invalid, server down), still store as a
    // legacy entry so the user can troubleshoot from inside the app.
    try {
      const r = await fetch(`${apiUrl}/api/whoami`, { headers: { "X-API-Key": key } });
      if (r.ok) {
        const body = await r.json();
        addOrUpdateProject({ id: body.id, name: body.name, api_key: key,
          github_repo: body.github_repo, plane_project_id: body.plane_project_id });
      } else {
        addOrUpdateProject({ id: '_unverified_' + Date.now(), name: 'project (unverified)', api_key: key });
      }
    } catch {
      addOrUpdateProject({ id: '_unverified_' + Date.now(), name: 'project (offline)', api_key: key });
    }
    setProjectVersion(v => v + 1);
  }

  useEffect(() => {
    if (!apiKey) return;
    fetch(`${apiUrl}/api/activity`, { headers: { "X-API-Key": apiKey } })
      .then((r) => (r.ok ? r.json() : []))
      .then(setActivities)
      .catch(() => {});
  }, [apiKey, apiUrl, projectVersion]);

  useEffect(() => {
    if (!apiKey) return;
    fetch(`${apiUrl}/api/stats`, { headers: { "X-API-Key": apiKey } })
      .then((r) => (r.ok ? r.json() : null))
      .then(setStats)
      .catch(() => {});
  }, [apiKey, apiUrl, refreshKey, projectVersion]);

  useEffect(() => {
    if (!apiKey) return;
    // Sidebar badge must match what the Inbox view actually shows. Earlier
    // versions counted /api/captures?status=new which double-counted captures
    // already dismissed/snoozed in inbox_state — leading to "Inbox 13" in
    // the badge while the view rendered 1 row. Use /api/inbox so badge and
    // view share one source of truth.
    fetch(`${apiUrl}/api/inbox`, { headers: { "X-API-Key": apiKey } })
      .then((r) => (r.ok ? r.json() : { counts: { total: 0 } }))
      .then((d) => setCapturesCount(d.counts?.total || 0))
      .catch(() => {});
  }, [apiKey, apiUrl, refreshKey, projectVersion]);

  useEffect(() => {
    if (!apiKey) return;

    function connect() {
      const es = new EventSource(`${apiUrl}/api/events?api_key=${apiKey}`);
      sseRef.current = es;

      es.onopen = () => setSseConnected(true);
      es.onerror = () => {
        setSseConnected(false);
        es.close();
        setTimeout(connect, 5000);
      };

      es.addEventListener("ticket:created", (e) => {
        const data = JSON.parse(e.data);
        setActivities((prev) => [
          { action: "created", detail: `${data.type}: ${data.title}`, ticket_id: data.id, created_at: new Date().toISOString() },
          ...prev.slice(0, 49),
        ]);
        setRefreshKey((k) => k + 1);
      });

      es.addEventListener("ticket:published", (e) => {
        const data = JSON.parse(e.data);
        setActivities((prev) => [
          { action: "published", detail: `→ GitHub issue #${data.issueNumber}`, ticket_id: data.id, created_at: new Date().toISOString() },
          ...prev.slice(0, 49),
        ]);
        setRefreshKey((k) => k + 1);
      });

      es.addEventListener("ticket:updated", (e) => {
        const data = JSON.parse(e.data);
        setActivities((prev) => [
          { action: data.status || "updated", detail: `Ticket #${data.id}`, ticket_id: data.id, created_at: new Date().toISOString() },
          ...prev.slice(0, 49),
        ]);
        setRefreshKey((k) => k + 1);
      });

      es.addEventListener("queue:update", (e) => {
        const data = JSON.parse(e.data);
        setQueueHealth(data);
      });

      // Inbox cache-bust — server fires this on capture create + (TODO) deploy
      // failure / workflow exhaustion. Causes InboxView to refetch on its
      // refreshKey effect.
      es.addEventListener("inbox:invalidate", () => {
        setRefreshKey((k) => k + 1);
      });
    }

    connect();
    return () => { sseRef.current?.close(); };
  }, [apiKey, apiUrl, projectVersion]);

  // Shelly health for the status-bar badge. Light 60s poll — the dedicated
  // Shelly view owns the heavy refresh and renders a fuller header.
  useEffect(() => {
    if (!apiKey) return;
    let cancelled = false;
    async function fetchShelly() {
      try {
        const r = await fetch(`${apiUrl}/api/shelly/status`, { headers: { 'X-API-Key': apiKey } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (!cancelled) setShellyStatus(d);
      } catch {
        if (!cancelled) setShellyStatus({ healthy: false });
      }
    }
    fetchShelly();
    const id = setInterval(fetchShelly, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [apiKey, apiUrl]);

  const tabStats = {
    pending: capturesCount,
    bugs: 0,
    features: 0,
  };

  // ── Main layout ─────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen bg-background">
      <Topbar
        currentProject={currentProject}
        onProjectSwitch={handleProjectSwitch}
        onManageProjects={() => handleTabChange('projects')}
        onAddProject={() => setShowAddProject(true)}
        onOpenPalette={() => setPaletteOpen(true)}
      />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          activeTab={activeTab}
          onTabChange={handleTabChange}
          stats={tabStats}
        />
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Cross-project pulse — only renders if 2+ projects are local */}
          <ProjectRibbon apiUrl={apiUrl} refreshKey={projectVersion} onSwitch={handleProjectSwitch} />
          <div className="flex-1 overflow-hidden">
            {/* Flight-deck — 4 primary surfaces */}
            {activeTab === "inbox" && <InboxView apiUrl={apiUrl} apiKey={apiKey} refreshKey={refreshKey} />}
            {activeTab === "fleet" && <FleetView apiUrl={apiUrl} apiKey={apiKey} adminKey={getAdminKey()} />}
            {activeTab === "fleet-live" && <FleetLiveView apiUrl={apiUrl} apiKey={apiKey} sseConnected={sseConnected} projectName={stats?.project || currentProject?.name} />}
            {activeTab === "memory" && <MemoryView apiUrl={apiUrl} apiKey={apiKey} />}
            {/* Legacy views — kept mountable during the transition */}
            {activeTab === "signals" && <SignalsView apiUrl={apiUrl} apiKey={apiKey} adminKey={getAdminKey()} />}
            {activeTab === "today" && <TodayView apiUrl={apiUrl} apiKey={apiKey} />}
            {activeTab === "captures" && <CapturesView apiUrl={apiUrl} apiKey={apiKey} />}
            {activeTab === "projects" && <ProjectsView apiUrl={apiUrl} onProjectChange={handleProjectSwitch} />}
            {activeTab === "queues" && <QueuesView apiUrl={apiUrl} apiKey={apiKey} queueHealth={queueHealth} sseConnected={sseConnected} />}
            {activeTab === "shelly" && <ShellyView apiUrl={apiUrl} apiKey={apiKey} />}
            {activeTab === "agents" && <AgentsView apiUrl={apiUrl} />}
            {activeTab === "work-items" && <WorkItemsView apiUrl={apiUrl} />}
            {activeTab === "ops" && <OpsView apiUrl={apiUrl} />}
            {activeTab === "settings" && <SettingsView apiUrl={apiUrl} apiKey={apiKey} />}
          </div>
          <CommandDock
            projectName={stats?.project || currentProject?.name}
            sseConnected={sseConnected}
            ticketCount={stats?.stats?.total}
            activeTab={activeTab}
            queueHealth={queueHealth}
            shellyStatus={shellyStatus}
          />
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onProjectSwitch={handleProjectSwitch}
        onAddProject={() => setShowAddProject(true)}
        commands={buildCommands({
          apiUrl,
          apiKey,
          adminKey: getAdminKey(),
          navigate: (tab) => handleTabChange(tab),
          navigateWithQuery: (tab, params) => {
            handleTabChange(tab);
            const qs = new URLSearchParams(params).toString();
            if (qs) window.history.replaceState(null, "", `/dashboard/${tab}?${qs}`);
          },
          openModal: async (name /* , opts */) => {
            // Phase 2 minimum — capture and memory-write open their own modals
            // mounted from the relevant view; from Cmd-K we route the user to
            // the surface where the modal appears. Param-prompt uses native
            // window.prompt for now; a polished form lands in a follow-up.
            if (name === 'capture') {
              setPaletteOpen(false);
              setGlobalCaptureOpen(true);
              return null;
            }
            if (name === 'memory-write') {
              setPaletteOpen(false);
              handleTabChange('memory');
              // The Memory view auto-opens its write modal when ?write=1 is set.
              window.history.replaceState(null, "", "/dashboard/memory?write=1");
              return null;
            }
            if (name === 'param-prompt') {
              // eslint-disable-next-line no-alert
              return window.prompt('input:');
            }
            return null;
          },
          toast: ({ kind, message }) => {
            // No toast component yet — fall back to console + alert for errors.
            // eslint-disable-next-line no-console
            console.log(`[cmd:${kind}]`, message);
            if (kind === 'error') {
              // eslint-disable-next-line no-alert
              window.alert(message);
            }
          },
        })}
      />

      {showAddProject && (
        <PasteUrlModal
          apiUrl={apiUrl}
          onClose={() => setShowAddProject(false)}
          onCreated={() => { setShowAddProject(false); handleProjectSwitch(); }}
        />
      )}

      {/* Global capture composer — reachable from Cmd-K's "New capture" command
          regardless of which surface the user is on. The Inbox view also has
          its own composer with the "c" shortcut, both hit the same /api/captures
          endpoint. */}
      <CaptureComposer
        open={globalCaptureOpen}
        apiUrl={apiUrl}
        apiKey={apiKey}
        onClose={() => setGlobalCaptureOpen(false)}
        onCreated={() => { setGlobalCaptureOpen(false); setRefreshKey(k => k + 1); }}
      />

      {/* DEVPA-167 — on dogfoode notre propre widget sur dev-panel.devpanl.dev.
          Le FAB et le chat drawer s'ajoutent au-dessus du dashboard et envoient
          captures + messages dans le projet courant (donc dans dev-panel quand
          c'est dev-panel qui est sélectionné). */}
      <DogfoodWidget apiUrl={apiUrl} apiKey={apiKey} />
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
