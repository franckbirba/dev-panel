import { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import { TabBar } from "@/components/tab-bar";
import { CommandDock } from "@/components/command-dock";
import { ProjectRibbon } from "@/components/project-ribbon";
import { InboxView } from "@/views/inbox-view";
import { DashboardView } from "@/views/dashboard-view";
import { SettingsView } from "@/views/settings-view";
import { QueuesView } from "@/views/queues-view";
import { ShellyView } from "@/views/shelly-view";
import { ProjectsView } from "@/views/projects-view";
import { TodayView } from "@/views/today-view";
import { CapturesView } from "@/views/captures-view";
import { SignalsView } from "@/views/signals-view";
import {
  migrateLegacy, listLocalProjects, getCurrentProject, addOrUpdateProject, getAdminKey
} from "@/lib/projects-store";

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
  const sseRef = useRef(null);

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

  if (!apiKey) {
    return (
      <div className="flex items-center justify-center h-screen bg-background empty-state">
        <form onSubmit={handleApiKeySubmit} className="card-glow flex flex-col gap-5 p-8 rounded-xl max-w-sm w-full">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold tracking-tight">DevPanel</h2>
            <p className="text-[13px] text-muted-foreground">Enter your API key to connect.</p>
          </div>
          <input
            name="apikey"
            type="password"
            placeholder="dp_..."
            autoComplete="off"
            autoFocus
            className="h-9 px-3 rounded-lg border border-border bg-background text-foreground font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring/60 transition-all placeholder:text-muted-foreground/40"
          />
          <button type="submit" className="h-9 rounded-lg bg-foreground text-background text-sm font-medium hover:bg-foreground/90 transition-colors cursor-pointer">
            Connect
          </button>
        </form>
      </div>
    );
  }

  const tabStats = stats?.stats
    ? { pending: stats.stats.pending, bugs: 0, features: 0 }
    : {};

  return (
    <div className="flex flex-col h-screen bg-background">
      <TabBar
        activeTab={activeTab}
        onTabChange={handleTabChange}
        stats={tabStats}
        activeFilter={filter}
        onFilterChange={setFilter}
        onProjectSwitch={handleProjectSwitch}
        apiUrl={apiUrl}
        apiKey={apiKey}
      />
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
      {activeTab !== "queues" && activeTab !== "projects" && (
        <CommandDock
          projectName={stats?.project || currentProject?.name}
          sseConnected={sseConnected}
          ticketCount={stats?.stats?.total}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
