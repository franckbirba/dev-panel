import { useState, useEffect, useRef, useCallback } from 'react';
import { ConsoleBuffer, NetworkInterceptor, PerfMetrics, takeScreenshot, takeDOMSnapshot } from './captureUtils.js';
import { SessionRecorder } from './sessionRecorder.js';
import { InspectOverlay } from './InspectOverlay.jsx';
import { RegionSelect } from './RegionSelect.jsx';
import { AnnotationCanvas } from './AnnotationCanvas.jsx';
import { BugReportPanel } from './BugReportPanel.jsx';
import { FeaturePanel } from './FeaturePanel.jsx';

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
  getState = null
}) {
  if (!apiKey) {
    console.warn('DevPanel: apiKey is required. Component will not render.');
    return null;
  }

  const [mode, setMode] = useState('idle');
  const [componentInfo, setComponentInfo] = useState(null);
  const [screenshot, setScreenshot] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState(null);

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

  // Start bug report directly: take a full-page screenshot in the background
  // and open the form. User can re-capture / pick element / annotate if needed.
  const startBugReport = useCallback(async () => {
    setMode('capturing');
    try {
      const shot = await takeScreenshot();
      if (shot) setScreenshot(shot);
    } catch { /* best effort */ }
    setMode('bug-report');
  }, []);

  const postCapture = useCallback(async ({ kind, content, metadata }) => {
    const createRes = await fetch(`${apiUrl}/api/captures`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ kind, content })
    });
    if (!createRes.ok) {
      const errData = await createRes.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${createRes.status}`);
    }
    const capture = await createRes.json();
    if (metadata) {
      const summary = [
        metadata.screenshot ? 'screenshot' : null,
        metadata.dom ? 'DOM snapshot' : null,
        metadata.appState ? 'app state' : null,
        Array.isArray(metadata.console) && metadata.console.length > 0 ? `${metadata.console.length} console entries` : null,
        Array.isArray(metadata.network) && metadata.network.length > 0 ? `${metadata.network.length} network events` : null,
      ].filter(Boolean).join(' · ') || 'browser context';
      await fetch(`${apiUrl}/api/threads/capture/${capture.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({
          role: 'system',
          content: `Captured: ${summary}`,
          metadata
        })
      }).catch(() => { /* context is best-effort */ });
    }
    return capture;
  }, [apiUrl, apiKey]);

  const submitBug = useCallback(async (description) => {
    setSubmitting(true);
    setMode('submitting');

    const name = componentInfo?.name || componentInfo?.displayName || 'Component';
    const title = componentInfo
      ? `${name}: ${description.slice(0, 60)}`
      : description.slice(0, 80);

    let appState = null;
    if (typeof getState === 'function') {
      try {
        const raw = getState();
        const serialized = JSON.stringify(raw);
        appState = serialized.length > 200 * 1024
          ? serialized.slice(0, 200 * 1024) + '... [truncated]'
          : raw;
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
      sessionReplay: sessionRecorder.current?.getEvents?.() ?? [],
      screenshot: screenshot || null,
      dom: takeDOMSnapshot(),
      appState
    };

    try {
      await postCapture({ kind: 'bug', content: description, metadata });
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
      await postCapture({ kind: 'feature', content, metadata });
      setToast({ kind: 'success', message: 'Feature submitted' });
    } catch (err) {
      setToast({ kind: 'error', message: err.message });
    }

    reset();
  }, [postCapture, reset]);

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
            setMode('capturing');
            try {
              const shot = await takeScreenshot();
              if (shot) setScreenshot(shot);
            } catch { /* best effort */ }
            setMode('bug-report');
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
    </>
  );
}
