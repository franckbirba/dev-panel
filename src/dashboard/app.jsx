import { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { CommandPalette } from "@/components/command-palette";
import { CommandDock } from "@/components/command-dock";
import { ProjectRibbon } from "@/components/project-ribbon";
import { PasteUrlModal } from "@/components/paste-url-modal";
import { InboxView } from "@/views/inbox-view";
import { DashboardView } from "@/views/dashboard-view";
import { SettingsView } from "@/views/settings-view";
import { QueuesView } from "@/views/queues-view";
import { ShellyView } from "@/views/shelly-view";
import { ProjectsView } from "@/views/projects-view";
import { TodayView } from "@/views/today-view";
import { CapturesView } from "@/views/captures-view";
import { SignalsView } from "@/views/signals-view";
import { IconLogo } from "@/components/icons";
import {
  migrateLegacy, listLocalProjects, getCurrentProject, addOrUpdateProject, getAdminKey
} from "@/lib/projects-store";
import { useAuth } from "@/lib/use-auth";
import { LoginView } from "@/views/login-view";

// Derive initial tab from URL
function getInitialTab() {
  const path = window.location.pathname;
  if (path.includes("/queues")) return "queues";
  if (path.includes("/shelly")) return "shelly";
  if (path.includes("/projects")) return "projects";
  if (path.includes("/settings")) return "settings";
  if (path.includes("/inbox") || path.includes("/captures")) return "captures";
  if (path.includes("/signals")) return "signals";
  if (path.includes("/dashboard/")) return "signals";
  return "signals";
}

function App() {
  // Migrate v1 storage on first mount, then read from v2.
  useEffect(() => { migrateLegacy(); }, []);

  // Auth gate — probe /auth/me (uses Lucia session cookie). If not authed,
  // render LoginView (Telegram OTP). The per-project api_key in localStorage
  // is still used for scoping requests but no longer authenticates the human.
  const { status: authStatus } = useAuth("");

  const [activeTab, setActiveTab] = useState(getInitialTab);
  const [filter, setFilter] = useState(null);
  // currentProject snapshot — re-read on switch via projectVersion bump.
  const [projectVersion, setProjectVersion] = useState(0);
  const currentProject = getCurrentProject();
  const apiKey = currentProject?.api_key || "";
  const [sseConnected, setSseConnected] = useState(false);
  const [activities, setActivities] = useState([]);
  const [stats, setStats] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [queueHealth, setQueueHealth] = useState(null);
  const [capturesCount, setCapturesCount] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [showAddProject, setShowAddProject] = useState(false);
  const sseRef = useRef(null);

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
    const path = tab === "queues" ? "/dashboard/queues"
      : tab === "shelly" ? "/dashboard/shelly"
      : tab === "projects" ? "/dashboard/projects"
      : tab === "settings" ? "/dashboard/settings"
      : tab === "signals" ? "/dashboard/signals"
      : tab === "captures" ? "/dashboard/captures"
      : tab === "inbox" ? "/dashboard/inbox"
      : "/dashboard/";
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
    fetch(`${apiUrl}/api/captures?status=new`, { headers: { "X-API-Key": apiKey } })
      .then((r) => (r.ok ? r.json() : { captures: [] }))
      .then((d) => setCapturesCount(d.captures?.length || 0))
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
    }

    connect();
    return () => { sseRef.current?.close(); };
  }, [apiKey, apiUrl, projectVersion]);

  // ── Auth gate (Telegram-via-Shelly OTP) ─────────────────
  if (authStatus === 'unknown') {
    return <div className="flex items-center justify-center h-screen text-sm text-muted-foreground">Connexion…</div>;
  }
  if (authStatus === 'unauthenticated') {
    return <LoginView apiUrl="" />;
  }

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
            {activeTab === "signals" && <SignalsView apiUrl={apiUrl} apiKey={apiKey} adminKey={getAdminKey()} />}
            {activeTab === "today" && <TodayView apiUrl={apiUrl} apiKey={apiKey} />}
            {activeTab === "captures" && <CapturesView apiUrl={apiUrl} apiKey={apiKey} />}
            {activeTab === "inbox" && <InboxView apiUrl={apiUrl} apiKey={apiKey} filter={filter} refreshKey={refreshKey} />}
            {activeTab === "dashboard" && <DashboardView apiUrl={apiUrl} apiKey={apiKey} activities={activities} refreshKey={refreshKey} queueHealth={queueHealth} />}
            {activeTab === "projects" && <ProjectsView apiUrl={apiUrl} onProjectChange={handleProjectSwitch} />}
            {activeTab === "queues" && <QueuesView apiUrl={apiUrl} apiKey={apiKey} queueHealth={queueHealth} sseConnected={sseConnected} />}
            {activeTab === "shelly" && <ShellyView apiUrl={apiUrl} apiKey={apiKey} />}
            {activeTab === "settings" && <SettingsView apiUrl={apiUrl} apiKey={apiKey} />}
          </div>
          <CommandDock
            projectName={stats?.project || currentProject?.name}
            sseConnected={sseConnected}
            ticketCount={stats?.stats?.total}
            activeTab={activeTab}
          />
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(tab) => handleTabChange(tab)}
        onProjectSwitch={handleProjectSwitch}
        onAddProject={() => setShowAddProject(true)}
      />

      {showAddProject && (
        <PasteUrlModal
          apiUrl={apiUrl}
          onClose={() => setShowAddProject(false)}
          onCreated={() => { setShowAddProject(false); handleProjectSwitch(); }}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
