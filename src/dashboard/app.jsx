import { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import { TabBar } from "@/components/tab-bar";
import { CommandDock } from "@/components/command-dock";
import { InboxView } from "@/views/inbox-view";
import { DashboardView } from "@/views/dashboard-view";
import { SettingsView } from "@/views/settings-view";
import { QueuesView } from "@/views/queues-view";

function getInitialTab() {
  const path = window.location.pathname;
  if (path.includes("/queues")) return "queues";
  if (path.includes("/settings")) return "settings";
  return "inbox";
}

function getInitialInboxParams() {
  const sp = new URLSearchParams(window.location.search);
  return {
    filter: sp.get("filter") || null,
    search: sp.get("q") || "",
    sort: sp.get("sort") || "created_at",
    order: sp.get("order") || "desc",
  };
}

function App() {
  const [activeTab, setActiveTab] = useState(getInitialTab);
  const [inboxParams, setInboxParams] = useState(getInitialInboxParams);
  const filter = inboxParams.filter;
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("devpanel_api_key") || "");
  const [sseConnected, setSseConnected] = useState(false);
  const [activities, setActivities] = useState([]);
  const [stats, setStats] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [queueHealth, setQueueHealth] = useState(null);
  const sseRef = useRef(null);

  const apiUrl = window.location.origin;

  function updateInboxParams(next) {
    setInboxParams(prev => {
      const merged = { ...prev, ...next };
      const sp = new URLSearchParams();
      if (merged.filter) sp.set("filter", merged.filter);
      if (merged.search) sp.set("q", merged.search);
      if (merged.sort && merged.sort !== "created_at") sp.set("sort", merged.sort);
      if (merged.order && merged.order !== "desc") sp.set("order", merged.order);
      const qs = sp.toString();
      window.history.replaceState(null, "", "/dashboard/" + (qs ? `?${qs}` : ""));
      return merged;
    });
  }

  function handleTabChange(tab) {
    setActiveTab(tab);
    const path = tab === "queues" ? "/dashboard/queues"
      : tab === "settings" ? "/dashboard/settings"
      : "/dashboard/";
    window.history.replaceState(null, "", path);
  }

  function handleApiKeySubmit(e) {
    e.preventDefault();
    const key = e.target.elements.apikey.value.trim();
    if (key) {
      localStorage.setItem("devpanel_api_key", key);
      setApiKey(key);
    }
  }

  useEffect(() => {
    if (!apiKey) return;
    fetch(`${apiUrl}/api/activity`, { headers: { "X-API-Key": apiKey } })
      .then((r) => (r.ok ? r.json() : []))
      .then(setActivities)
      .catch(() => {});
  }, [apiKey, apiUrl]);

  useEffect(() => {
    if (!apiKey) return;
    fetch(`${apiUrl}/api/stats`, { headers: { "X-API-Key": apiKey } })
      .then((r) => (r.ok ? r.json() : null))
      .then(setStats)
      .catch(() => {});
  }, [apiKey, apiUrl, refreshKey]);

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
  }, [apiKey, apiUrl]);

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
        onFilterChange={(f) => updateInboxParams({ filter: f === filter ? null : f })}
      />
      <div className="flex-1 overflow-hidden">
        {activeTab === "inbox" && <InboxView apiUrl={apiUrl} apiKey={apiKey} filter={filter} search={inboxParams.search} sort={inboxParams.sort} order={inboxParams.order} onParamsChange={updateInboxParams} refreshKey={refreshKey} />}
        {activeTab === "dashboard" && <DashboardView apiUrl={apiUrl} apiKey={apiKey} activities={activities} refreshKey={refreshKey} queueHealth={queueHealth} />}
        {activeTab === "queues" && <QueuesView apiUrl={apiUrl} apiKey={apiKey} queueHealth={queueHealth} sseConnected={sseConnected} />}
        {activeTab === "settings" && <SettingsView apiUrl={apiUrl} apiKey={apiKey} />}
      </div>
      {activeTab !== "queues" && (
        <CommandDock
          projectName={stats?.project}
          sseConnected={sseConnected}
          ticketCount={stats?.stats?.total}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
