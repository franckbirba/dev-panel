// Renders the rich browser-context payload the widget attaches to a capture's
// system message: screenshot, URL/viewport/UA/component, console, network,
// session replay, performance, app state, DOM snapshot. Used by both the
// flight-deck Inbox (ThreadPanel) and the legacy Captures view.

function fmtTs(ts) {
  if (typeof ts !== 'number') return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(11, 23);
}

const CONSOLE_TONE = {
  log:   'text-[var(--color-foreground-muted)]',
  warn:  'text-[var(--color-warning)]',
  error: 'text-[var(--color-error)]',
};

export function parseMessageMetadata(metadata) {
  if (!metadata) return null;
  try {
    return typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
  } catch {
    return null;
  }
}

export function CaptureScreenshot({ meta }) {
  const screenshot = meta?.screenshot && typeof meta.screenshot === 'string' && meta.screenshot.startsWith('data:image')
    ? meta.screenshot : null;
  if (!screenshot) return null;
  return (
    <a href={screenshot} target="_blank" rel="noreferrer" className="block mt-2">
      <img
        src={screenshot}
        alt="screenshot"
        className="rounded border border-[var(--color-border)] max-h-64 w-auto hover:opacity-90 transition-opacity"
      />
    </a>
  );
}

export function CaptureMetaPanel({ meta }) {
  if (!meta || typeof meta !== 'object') return null;
  const consoleEntries = Array.isArray(meta.console) ? meta.console : [];
  const networkErrors  = Array.isArray(meta.network) ? meta.network : [];
  const sessionReplay  = Array.isArray(meta.sessionReplay) ? meta.sessionReplay : [];
  const perf           = meta.performance && typeof meta.performance === 'object' ? meta.performance : null;
  const component      = meta.component;
  const dom            = typeof meta.dom === 'string' ? meta.dom : null;
  const appState       = meta.appState && typeof meta.appState === 'object' ? meta.appState : null;
  const componentProps = component?.props && typeof component.props === 'object' ? component.props : null;
  const hasComponentProps = componentProps && Object.keys(componentProps).length > 0;

  const hasContext = meta.url || meta.viewport || meta.userAgent || component;
  if (!hasContext && !consoleEntries.length && !networkErrors.length && !sessionReplay.length && !perf && !dom && !appState) {
    return null;
  }

  return (
    <div className="mt-2 space-y-1 text-[11px]">
      {hasContext && (
        <details className="opacity-75" open>
          <summary className="cursor-pointer select-none">context</summary>
          <div className="mt-1 space-y-0.5 font-mono">
            {meta.url && <div>url: <a href={meta.url} target="_blank" rel="noreferrer" className="underline">{meta.url}</a></div>}
            {meta.viewport && <div>viewport: {meta.viewport.width}×{meta.viewport.height}</div>}
            {component?.name && <div>component: {component.name}{component.file ? ` (${component.file})` : ''}</div>}
            {hasComponentProps && (
              <pre className="whitespace-pre-wrap break-all opacity-80">props: {JSON.stringify(componentProps, null, 2)}</pre>
            )}
            {meta.userAgent && <div className="truncate" title={meta.userAgent}>ua: {meta.userAgent}</div>}
          </div>
        </details>
      )}

      {consoleEntries.length > 0 && (
        <details className="opacity-90">
          <summary className="cursor-pointer select-none">console ({consoleEntries.length})</summary>
          <div className="mt-1 max-h-48 overflow-y-auto rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-2 font-mono text-[10.5px] space-y-0.5">
            {consoleEntries.map((e, idx) => (
              <div key={idx} className={`flex gap-2 ${CONSOLE_TONE[e.level] || ''}`}>
                <span className="opacity-50 shrink-0">{fmtTs(e.timestamp)}</span>
                <span className="uppercase shrink-0 w-10">{e.level}</span>
                <span className="whitespace-pre-wrap break-all">{e.message}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {networkErrors.length > 0 && (
        <details className="opacity-90">
          <summary className="cursor-pointer select-none">failed requests ({networkErrors.length})</summary>
          <div className="mt-1 max-h-48 overflow-y-auto rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-2 font-mono text-[10.5px] space-y-0.5">
            {networkErrors.map((n, idx) => (
              <div key={idx} className="flex gap-2 text-[var(--color-error)]">
                <span className="opacity-50 shrink-0">{fmtTs(n.timestamp)}</span>
                <span className="shrink-0 w-12">{n.method}</span>
                <span className="shrink-0 w-12">{n.status}</span>
                <span className="break-all">{n.url}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {sessionReplay.length > 0 && (
        <details className="opacity-90">
          <summary className="cursor-pointer select-none">session replay ({sessionReplay.length} events, last 30s)</summary>
          <div className="mt-1 max-h-48 overflow-y-auto rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-2 font-mono text-[10.5px] space-y-0.5">
            {sessionReplay.map((ev, idx) => (
              <div key={idx} className="flex gap-2 text-[var(--color-foreground-muted)]">
                <span className="opacity-50 shrink-0 w-12 text-right">
                  {typeof ev.ts === 'number' ? `${(ev.ts / 1000).toFixed(2)}s` : ''}
                </span>
                <span className="shrink-0 w-16">{ev.type}</span>
                <span className="break-all">
                  {ev.type === 'click' && `${ev.target} @ ${ev.x},${ev.y}`}
                  {ev.type === 'scroll' && `${ev.target} → ${ev.scrollX},${ev.scrollY}`}
                  {ev.type === 'input' && ev.target}
                  {ev.type === 'navigation' && `${ev.from} → ${ev.to}`}
                  {ev.type === 'mutation' && `+${ev.added} -${ev.removed}`}
                  {ev.type === 'resize' && `${ev.width}×${ev.height}`}
                  {ev.type === 'error' && `${ev.message} (${ev.filename}:${ev.lineno})`}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}

      {perf && (perf.lcp != null || perf.cls != null || perf.fcp != null) && (
        <details className="opacity-90">
          <summary className="cursor-pointer select-none">performance</summary>
          <div className="mt-1 font-mono space-y-0.5">
            {perf.lcp != null && <div>LCP: {Math.round(perf.lcp)}ms</div>}
            {perf.fcp != null && <div>FCP: {Math.round(perf.fcp)}ms</div>}
            {perf.cls != null && <div>CLS: {perf.cls}</div>}
          </div>
        </details>
      )}

      {appState && (
        <details className="opacity-90">
          <summary className="cursor-pointer select-none">
            app state{appState.truncated ? ' (truncated)' : ''}
          </summary>
          <pre className="mt-1 max-h-64 overflow-auto rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-2 font-mono text-[10.5px] whitespace-pre-wrap break-all">
            {appState.json}
          </pre>
        </details>
      )}

      {dom && (
        <details className="opacity-90">
          <summary className="cursor-pointer select-none">DOM snapshot ({Math.round(dom.length / 1024)} KB)</summary>
          <pre className="mt-1 max-h-64 overflow-auto rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-2 font-mono text-[10.5px] whitespace-pre-wrap break-all">
            {dom}
          </pre>
        </details>
      )}
    </div>
  );
}
