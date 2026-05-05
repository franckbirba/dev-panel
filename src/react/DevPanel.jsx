import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ConsoleBuffer, NetworkInterceptor, PerfMetrics, captureViaDisplayMedia, takeDOMSnapshot } from './captureUtils.js';
import { SessionRecorder } from './sessionRecorder.js';
import { InspectOverlay } from './InspectOverlay.jsx';
import { RegionSelect } from './RegionSelect.jsx';
import { AnnotationCanvas } from './AnnotationCanvas.jsx';
import { BugReportPanel } from './BugReportPanel.jsx';
import { FeaturePanel } from './FeaturePanel.jsx';
import { postCapture as postCaptureFlow } from './captureFlow.js';
import { ChatDrawer } from './chat/ChatDrawer.jsx';
import { getOrCreateSessionId } from './chat/sessionId.js';

const ANIMATIONS = `
  @keyframes devpanel-fade-in {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes devpanel-slide-in {
    from { transform: translateX(100%); }
    to { transform: translateX(0); }
  }
`;

export function DevPanel({
  apiUrl = 'http://localhost:3030',
  apiKey,
  position = 'bottom-right',
  getState = null,
  user = null,
  environment = null,
  chat = false
}) {
  const [mode, setMode] = useState('idle');
  const [componentInfo, setComponentInfo] = useState(null);
  const [screenshot, setScreenshot] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState(null);
  const [labels, setLabels] = useState([]);
  const [category, setCategory] = useState('');

  const consoleBuffer = useRef(null);
  const networkInterceptor = useRef(null);
  const perfMetrics = useRef(null);
  const sessionRecorder = useRef(null);

  // Mount capture utils
  useEffect(() => {
    consoleBuffer.current = new ConsoleBuffer(50);
    networkInterceptor.current = new NetworkInterceptor(50);
    perfMetrics.current = new PerfMetrics();
    sessionRecorder.current = new SessionRecorder();

    consoleBuffer.current.attach();
    networkInterceptor.current.attach();
    perfMetrics.current.attach();
    sessionRecorder.current.attach();

    return () => {
      consoleBuffer.current?.detach();
      networkInterceptor.current?.detach();
      perfMetrics.current?.detach();
      sessionRecorder.current?.detach();
    };
  }, []);

  // Auto-clear toast after 3000ms
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  // Fetch team labels for category dropdown (tolerates failure silently)
  useEffect(() => {
    if (!apiKey || !apiUrl) return;
    let cancelled = false;
    fetch(`${apiUrl}/api/team/labels`, { headers: { 'X-API-Key': apiKey } })
      .then(r => r.ok ? r.json() : [])
      .then(data => { if (!cancelled) setLabels(Array.isArray(data) ? data : []); })
      .catch(() => { /* widget keeps working without categories */ });
    return () => { cancelled = true; };
  }, [apiKey, apiUrl]);

  // Escape key: menu → idle
  useEffect(() => {
    if (mode !== 'menu') return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setMode('idle');
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [mode]);

  const reset = useCallback(() => {
    setMode('idle');
    setComponentInfo(null);
    setScreenshot(null);
    setSubmitting(false);
  }, []);

  const handleInspectSelect = useCallback((info) => {
    setComponentInfo(info);
    setMode('bug-report');
  }, []);

  const handleRegionCapture = useCallback((screenshotBase64) => {
    if (screenshotBase64) setScreenshot(screenshotBase64);
    setMode('bug-report');
  }, []);

  const handleAnnotationDone = useCallback((annotated) => {
    setScreenshot(annotated);
    setMode('bug-report');
  }, []);

  // Open the bug-report form immediately with no screenshot. The user
  // triggers the capture explicitly from the "retake" button, which uses
  // navigator.mediaDevices.getDisplayMedia() — a native browser screenshot
  // that's pixel-perfect (no CSS guessing like html2canvas did).
  const startBugReport = useCallback(() => {
    setMode('bug-report');
  }, []);

  const postCapture = useCallback(
    ({ kind, content, metadata, category: cat }) =>
      postCaptureFlow({ apiUrl, apiKey, user, environment, kind, content, metadata, category: cat }),
    [apiUrl, apiKey, user, environment],
  );

  const chatSessionId = useMemo(() => (chat ? getOrCreateSessionId() : null), [chat]);

  const submitBug = useCallback(async (description) => {
    setSubmitting(true);
    setMode('submitting');

    const name = componentInfo?.name || componentInfo?.displayName || 'Component';
    const title = componentInfo
      ? `${name}: ${description.slice(0, 60)}`
      : description.slice(0, 80);

    const APP_STATE_MAX_BYTES = 200 * 1024;
    let appState = null;
    if (typeof getState === 'function') {
      try {
        const serialized = JSON.stringify(getState());
        if (serialized != null) {
          appState = serialized.length > APP_STATE_MAX_BYTES
            ? { truncated: true, json: serialized.slice(0, APP_STATE_MAX_BYTES) }
            : { truncated: false, json: serialized };
        }
      } catch { appState = null; }
    }

    const metadata = {
      type: 'bug',
      title,
      url: window.location.href,
      userAgent: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      timestamp: Date.now(),
      component: componentInfo || null,
      console: consoleBuffer.current?.getEntries?.() ?? [],
      network: networkInterceptor.current?.getErrors?.() ?? [],
      performance: perfMetrics.current?.getMetrics?.() ?? {},
      sessionReplay: sessionRecorder.current?.getSessionReplay?.() ?? [],
      screenshot: screenshot || null,
      dom: takeDOMSnapshot(),
      appState
    };

    try {
      await postCapture({ kind: 'bug', content: description, metadata, category: category || undefined });
      setToast({ kind: 'success', message: 'Bug reported' });
    } catch (err) {
      setToast({ kind: 'error', message: err.message });
    }

    reset();
  }, [postCapture, componentInfo, screenshot, getState, reset]);

  const submitFeature = useCallback(async (title, description) => {
    setSubmitting(true);
    setMode('submitting');

    const metadata = {
      type: 'feature',
      title,
      url: window.location.href,
      userAgent: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      timestamp: Date.now()
    };
    const content = `${title}\n\n${description}`;

    try {
      await postCapture({ kind: 'feature', content, metadata, category: category || undefined });
      setToast({ kind: 'success', message: 'Feature submitted' });
    } catch (err) {
      setToast({ kind: 'error', message: err.message });
    }

    reset();
  }, [postCapture, reset]);

  // Gate AFTER every hook: when apiKey is missing the widget cannot post
  // captures, so we render nothing. The check must run after every hook above
  // so React's hook-call-order rule holds when consumer apps toggle apiKey
  // on/off (e.g. during SSO hydration or a project switch). Pre-fix this
  // returned early before any hook, which crashed the component on the
  // toggle render with "Rendered more hooks than during the previous render"
  // (GlitchTip issue #41).
  useEffect(() => {
    if (!apiKey) console.warn('DevPanel: apiKey is required. Component will not render.');
  }, [apiKey]);
  if (!apiKey) return null;

  const isRight = position === 'bottom-right';
  const sideKey = isRight ? 'right' : 'left';

  // FAB button
  const fabStyle = {
    position: 'fixed',
    bottom: '24px',
    [sideKey]: '24px',
    width: '48px',
    height: '48px',
    borderRadius: '50%',
    border: 'none',
    cursor: 'pointer',
    fontSize: '22px',
    zIndex: 99999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: mode === 'menu' ? '#333' : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
    boxShadow: '0 4px 16px rgba(99,102,241,0.4)',
    transition: 'background 0.2s'
  };

  // Menu popover style
  const menuStyle = {
    position: 'fixed',
    bottom: '80px',
    [sideKey]: '24px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    zIndex: 99999,
    animation: 'devpanel-fade-in 0.18s ease'
  };

  const menuBtnBase = {
    minWidth: '180px',
    padding: '10px 16px',
    borderRadius: '10px',
    fontWeight: 600,
    fontSize: '13px',
    border: 'none',
    cursor: 'pointer',
    color: 'white',
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)'
  };

  // Toast style
  const toastStyle = toast ? {
    position: 'fixed',
    bottom: '80px',
    [sideKey]: '24px',
    zIndex: 100000,
    padding: '10px 16px',
    borderRadius: '10px',
    fontWeight: 600,
    fontSize: '13px',
    color: 'white',
    backgroundColor: toast.kind === 'success' ? '#10b981' : '#ef4444',
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    animation: 'devpanel-fade-in 0.18s ease'
  } : null;

  const showFab = mode === 'idle' || mode === 'menu';

  return (
    <>
      <style data-devtool-ignore>{ANIMATIONS}</style>

      {/* FAB */}
      {showFab && (
        <button
          data-devtool-ignore
          style={fabStyle}
          onClick={() => setMode(mode === 'menu' ? 'idle' : 'menu')}
          aria-label="DevPanel"
        >
          🐛
        </button>
      )}

      {/* Menu popover */}
      {mode === 'menu' && (
        <div data-devtool-ignore style={menuStyle}>
          <button
            data-devtool-ignore
            style={{ ...menuBtnBase, backgroundColor: '#ef4444' }}
            onClick={startBugReport}
          >
            🐛 Report Bug
          </button>
          <button
            data-devtool-ignore
            style={{ ...menuBtnBase, backgroundColor: '#6366f1' }}
            onClick={() => setMode('feature-panel')}
          >
            ✨ Request Feature
          </button>
          {labels.length > 0 && (
            <select
              data-devtool-ignore
              value={category}
              onChange={e => setCategory(e.target.value)}
              style={{
                minWidth: '180px',
                padding: '8px 10px',
                borderRadius: '10px',
                fontSize: '13px',
                border: '1px solid #444',
                background: '#1a1a2e',
                color: 'white',
                cursor: 'pointer'
              }}
            >
              <option value="">— Auto (Shelly choisit) —</option>
              {labels.map(l => (
                <option key={l.label} value={l.label}>
                  {l.label}{l.member_name ? ` (${l.member_name})` : ''}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Overlays / panels */}
      {mode === 'inspecting' && (
        <InspectOverlay
          data-devtool-ignore
          onSelect={handleInspectSelect}
          onCancel={() => setMode('menu')}
        />
      )}

      {mode === 'region-select' && (
        <RegionSelect
          data-devtool-ignore
          onCapture={handleRegionCapture}
          onCancel={() => setMode('inspecting')}
        />
      )}

      {mode === 'annotating' && (
        <AnnotationCanvas
          data-devtool-ignore
          screenshot={screenshot}
          onDone={handleAnnotationDone}
          onCancel={() => setMode('region-select')}
        />
      )}

      {mode === 'capturing' && (
        <div data-devtool-ignore style={{
          position: 'fixed', inset: 0, zIndex: 99999,
          background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'white', fontSize: '14px', fontFamily: 'system-ui, sans-serif'
        }}>
          <div style={{ background: '#1a1a2e', padding: '14px 20px', borderRadius: '10px', boxShadow: '0 4px 16px rgba(0,0,0,0.4)' }}>
            Capturing screenshot…
          </div>
        </div>
      )}

      {(mode === 'bug-report' || mode === 'submitting') && (
        <BugReportPanel
          data-devtool-ignore
          componentInfo={componentInfo}
          screenshot={screenshot}
          onSubmit={submitBug}
          onCancel={reset}
          onPickElement={() => setMode('inspecting')}
          onRecapture={async () => {
            // Explicit user action — fire the native display-media prompt.
            // No 'capturing' mode switch: the browser's share-picker is
            // already its own modal, and we want the form visible behind
            // it so the description doesn't get wiped.
            const shot = await captureViaDisplayMedia();
            if (shot) setScreenshot(shot);
          }}
          onAnnotate={() => screenshot && setMode('annotating')}
          submitting={submitting}
        />
      )}

      {mode === 'feature-panel' && (
        <FeaturePanel
          data-devtool-ignore
          onSubmit={submitFeature}
          onCancel={reset}
          submitting={submitting}
        />
      )}

      {/* Toast */}
      {toast && (
        <div data-devtool-ignore style={toastStyle}>
          {toast.kind === 'success' ? '✓' : '✗'} {toast.message}
        </div>
      )}

      {/* Persistent chat drawer (opt-in via `chat` prop) */}
      {chat && chatSessionId && (
        <ChatDrawer
          apiUrl={apiUrl}
          apiKey={apiKey}
          sessionId={chatSessionId}
          user={user}
          environment={environment}
          position={position}
        />
      )}
    </>
  );
}
