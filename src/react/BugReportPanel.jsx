import React, { useState } from 'react';

const STYLE = {
  panel: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    width: '400px',
    zIndex: 99999,
    background: '#1a1a2e',
    color: '#e0e0e0',
    boxShadow: '-4px 0 24px rgba(0,0,0,0.5)',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: 'system-ui, sans-serif',
    animation: 'devpanel-slide-in 0.2s ease-out',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 16px',
    borderBottom: '1px solid #2a2a4a',
    flexShrink: 0,
  },
  headerTitle: {
    fontWeight: 600,
    fontSize: '15px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: '#888',
    fontSize: '20px',
    cursor: 'pointer',
    padding: '0 4px',
    lineHeight: 1,
  },
  scrollArea: {
    flex: 1,
    overflowY: 'auto',
    padding: '12px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  section: {
    background: '#16213e',
    borderRadius: '8px',
    padding: '12px',
  },
  sectionTitle: {
    fontSize: '11px',
    fontWeight: 600,
    marginBottom: '8px',
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
  },
  mono: {
    fontFamily: 'monospace',
    fontSize: '10px',
  },
  textarea: {
    width: '100%',
    minHeight: '80px',
    background: '#16213e',
    border: '1px solid #333',
    borderRadius: '8px',
    color: '#e0e0e0',
    padding: '10px',
    fontSize: '13px',
    fontFamily: 'system-ui, sans-serif',
    resize: 'vertical',
    boxSizing: 'border-box',
    outline: 'none',
  },
  footer: {
    padding: '12px 16px',
    borderTop: '1px solid #2a2a4a',
    display: 'flex',
    gap: '8px',
    flexShrink: 0,
  },
  submitBtn: (disabled) => ({
    flex: 1,
    padding: '10px',
    background: disabled ? '#333' : '#ef4444',
    color: disabled ? '#888' : '#fff',
    border: 'none',
    borderRadius: '8px',
    fontWeight: 600,
    fontSize: '13px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'background 0.15s',
  }),
  cancelBtn: {
    padding: '10px 16px',
    background: '#333',
    color: '#888',
    border: 'none',
    borderRadius: '8px',
    fontWeight: 600,
    fontSize: '13px',
    cursor: 'pointer',
  },
};

function perfColor(metric, value) {
  if (value === null || value === undefined) return '#888';
  const thresholds = {
    fcp: { good: 1800, bad: 3000 },
    lcp: { good: 2500, bad: 4000 },
    cls: { good: 0.1, bad: 0.25 },
  };
  const t = thresholds[metric];
  if (!t) return '#888';
  if (value <= t.good) return '#22c55e';
  if (value <= t.bad) return '#f59e0b';
  return '#ef4444';
}

function truncate(str, n) {
  return str && str.length > n ? str.slice(0, n) + '…' : str;
}

const KEYFRAMES = `
@keyframes devpanel-slide-in {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}
`;

function injectKeyframes() {
  if (typeof document !== 'undefined' && !document.getElementById('devpanel-keyframes')) {
    const style = document.createElement('style');
    style.id = 'devpanel-keyframes';
    style.textContent = KEYFRAMES;
    document.head.appendChild(style);
  }
}

// Production bundles minify component display names to 1-3 letters (e.g. "Xae").
// When that's what we get, the label is misleading — hide it.
function isUsefulComponentName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.length <= 3) return false;
  if (/^[A-Z][a-z]{0,2}$/.test(name)) return false;
  return true;
}

export function BugReportPanel({
  componentInfo,
  consoleEntries = [],
  networkErrors = [],
  perfMetrics = {},
  screenshot,
  onSubmit,
  onCancel,
  onPickElement,
  onRecapture,
  onAnnotate,
  submitting = false,
}) {
  injectKeyframes();

  const [description, setDescription] = useState('');
  const [screenshotExpanded, setScreenshotExpanded] = useState(false);

  const errorCount = consoleEntries.filter((e) => e.level === 'error').length;
  const warnCount = consoleEntries.filter((e) => e.level === 'warn').length;
  const lastConsole = consoleEntries.slice(-5);
  const lastNetwork = networkErrors.slice(-5);

  const { lcp, cls, fcp } = perfMetrics || {};
  const hasPerf = lcp != null || fcp != null;

  const showComponentName = isUsefulComponentName(componentInfo?.name);

  const handleSubmit = () => {
    if (!description.trim() || submitting) return;
    onSubmit(description);
  };

  const entryColor = (level) => {
    if (level === 'error') return '#ef4444';
    if (level === 'warn') return '#f59e0b';
    return '#888';
  };

  return (
    <div style={STYLE.panel} data-devtool-ignore>
      {/* Header */}
      <div style={STYLE.header} data-devtool-ignore>
        <span style={STYLE.headerTitle} data-devtool-ignore>
          🐛 Bug Report
        </span>
        <button style={STYLE.closeBtn} onClick={onCancel} data-devtool-ignore>
          ×
        </button>
      </div>

      {/* Scroll area */}
      <div style={STYLE.scrollArea} data-devtool-ignore>

        {/* Component info — only when we got something useful (prod builds
            often minify names down to meaningless 1-3 letter symbols). */}
        {componentInfo && (showComponentName || componentInfo.file) && (
          <div style={STYLE.section} data-devtool-ignore>
            <div style={{ ...STYLE.sectionTitle, color: '#ef4444' }} data-devtool-ignore>
              Selected: {showComponentName ? componentInfo.name : 'element'}
            </div>
            {componentInfo.file && (
              <div style={{ ...STYLE.mono, color: '#888', marginBottom: '6px' }} data-devtool-ignore>
                {componentInfo.file}
              </div>
            )}
            {componentInfo.props && Object.keys(componentInfo.props).length > 0 && (
              <pre style={{ ...STYLE.mono, color: '#a0aec0', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }} data-devtool-ignore>
                {JSON.stringify(componentInfo.props, null, 2)}
              </pre>
            )}
          </div>
        )}

        {/* Console errors */}
        {(errorCount > 0 || warnCount > 0) && (
          <div style={STYLE.section} data-devtool-ignore>
            <div style={{ ...STYLE.sectionTitle, color: '#f59e0b' }} data-devtool-ignore>
              ⚠ Console ({errorCount} errors, {warnCount} warnings)
            </div>
            {lastConsole.map((entry, i) => (
              <div
                key={i}
                style={{ ...STYLE.mono, color: entryColor(entry.level), marginBottom: '3px' }}
                data-devtool-ignore
              >
                {truncate(entry.message, 120)}
              </div>
            ))}
          </div>
        )}

        {/* Network errors */}
        {lastNetwork.length > 0 && (
          <div style={STYLE.section} data-devtool-ignore>
            <div style={{ ...STYLE.sectionTitle, color: '#ef4444' }} data-devtool-ignore>
              Failed requests ({networkErrors.length})
            </div>
            {lastNetwork.map((req, i) => (
              <div
                key={i}
                style={{ ...STYLE.mono, color: '#ef4444', marginBottom: '3px' }}
                data-devtool-ignore
              >
                {req.method} {truncate(req.url, 60)} → {req.status}
              </div>
            ))}
          </div>
        )}

        {/* Performance */}
        {hasPerf && (
          <div style={STYLE.section} data-devtool-ignore>
            <div style={{ ...STYLE.sectionTitle, color: '#6366f1' }} data-devtool-ignore>
              Performance
            </div>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }} data-devtool-ignore>
              {fcp != null && (
                <span style={{ fontSize: '11px', color: perfColor('fcp', fcp) }} data-devtool-ignore>
                  FCP {Math.round(fcp)}ms
                </span>
              )}
              {lcp != null && (
                <span style={{ fontSize: '11px', color: perfColor('lcp', lcp) }} data-devtool-ignore>
                  LCP {Math.round(lcp)}ms
                </span>
              )}
              {cls != null && (
                <span style={{ fontSize: '11px', color: perfColor('cls', cls) }} data-devtool-ignore>
                  CLS {cls.toFixed(3)}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Description — most important, keep at top */}
        <div data-devtool-ignore>
          <textarea
            style={STYLE.textarea}
            placeholder="What went wrong? (required)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            autoFocus
            data-devtool-ignore
          />
        </div>

        {/* Screenshot + actions */}
        <div style={STYLE.section} data-devtool-ignore>
          <div style={{ ...STYLE.sectionTitle, color: '#10b981', justifyContent: 'space-between' }} data-devtool-ignore>
            <span data-devtool-ignore>Screenshot</span>
            <div style={{ display: 'flex', gap: '6px' }} data-devtool-ignore>
              {onRecapture && (
                <button
                  data-devtool-ignore
                  onClick={onRecapture}
                  style={{ background: 'none', border: '1px solid #333', color: '#a0aec0', fontSize: '11px', padding: '2px 8px', borderRadius: '4px', cursor: 'pointer' }}
                  title="Capture a screenshot via the browser's share picker"
                >
                  {screenshot ? '📸 retake' : '📸 capture'}
                </button>
              )}
              {onAnnotate && screenshot && (
                <button
                  data-devtool-ignore
                  onClick={onAnnotate}
                  style={{ background: 'none', border: '1px solid #333', color: '#a0aec0', fontSize: '11px', padding: '2px 8px', borderRadius: '4px', cursor: 'pointer' }}
                  title="Draw arrows or highlights on the screenshot"
                >
                  annotate
                </button>
              )}
              {onPickElement && (
                <button
                  data-devtool-ignore
                  onClick={onPickElement}
                  style={{ background: 'none', border: '1px solid #333', color: '#a0aec0', fontSize: '11px', padding: '2px 8px', borderRadius: '4px', cursor: 'pointer' }}
                  title="Select a specific element instead"
                >
                  pick element
                </button>
              )}
            </div>
          </div>
          {screenshot ? (
            <img
              src={screenshot.startsWith('data:') ? screenshot : `data:image/png;base64,${screenshot}`}
              alt="screenshot"
              onClick={() => setScreenshotExpanded((v) => !v)}
              style={{
                width: '100%',
                maxHeight: screenshotExpanded ? 'none' : '150px',
                objectFit: screenshotExpanded ? 'contain' : 'cover',
                borderRadius: '4px',
                cursor: 'pointer',
                display: 'block',
              }}
              data-devtool-ignore
            />
          ) : (
            <div style={{ fontSize: '11px', color: '#888' }} data-devtool-ignore>
              Click "📸 capture" to attach a screenshot (optional).
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div style={STYLE.footer} data-devtool-ignore>
        <button
          style={STYLE.submitBtn(!description.trim() || submitting)}
          disabled={!description.trim() || submitting}
          onClick={handleSubmit}
          data-devtool-ignore
        >
          {submitting ? 'Submitting…' : 'Submit Bug Report'}
        </button>
        <button style={STYLE.cancelBtn} onClick={onCancel} data-devtool-ignore>
          Cancel
        </button>
      </div>
    </div>
  );
}

