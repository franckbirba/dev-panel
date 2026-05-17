// Widget-side cards for the @devpanl/chat-renderer schema (DEVPA-210).
//
// Mirror of the dashboard's RendererPayloadView but with a smaller
// registry: only the payload types the widget can realistically render
// inside a 360px floating drawer. Unhandled types fall through to a
// muted one-liner. The widget intentionally does *not* import the
// dashboard's shadcn cards — pulling that in would balloon the iife
// bundle. Inline styles only, same convention as ChatDrawer.jsx.

import { extractRendererPayload } from '../../packages/chat-renderer/parser.js';

const cardBoxStyle = {
  border: '1px solid #2a2a4a',
  borderRadius: 10,
  padding: '10px 12px',
  background: '#11122a',
  color: '#e6e6f0',
  fontSize: 12.5,
  lineHeight: 1.45,
};

const chipsRowStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  marginTop: 8,
};

function chipStyle(variant) {
  return {
    padding: '4px 10px',
    borderRadius: 999,
    border: '1px solid #2a2a4a',
    cursor: 'pointer',
    fontSize: 12,
    fontFamily: 'inherit',
    background:
      variant === 'primary' ? '#6366f1'
      : variant === 'danger' ? '#7f1d1d'
      : '#1d1f3a',
    color: 'white',
  };
}

function ErrorHaltCard({ payload, onAction }) {
  return (
    <div style={{ ...cardBoxStyle, borderColor: '#7f1d1d' }}>
      <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, opacity: 0.8 }}>
        {payload.source ? `${payload.source} · ` : ''}{payload.error_code}
      </div>
      <div style={{ marginTop: 4 }}>{payload.message}</div>
      {payload.recovery_prompt && (
        <div style={{ marginTop: 6, opacity: 0.9 }}>{payload.recovery_prompt}</div>
      )}
      {payload.actions && payload.actions.length > 0 && (
        <div style={chipsRowStyle}>
          {payload.actions.map((a) => (
            <button
              key={a.id}
              type="button"
              style={chipStyle(a.variant)}
              onClick={() => onAction?.(a)}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function InlineActionsCard({ payload, onAction }) {
  return (
    <div style={cardBoxStyle}>
      {payload.prompt && <div>{payload.prompt}</div>}
      <div style={chipsRowStyle}>
        {payload.actions.map((a) => (
          <button
            key={a.id}
            type="button"
            style={chipStyle(a.variant)}
            onClick={() => onAction?.(a)}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function QueueCard({ payload, onAction }) {
  return (
    <div style={cardBoxStyle}>
      <div style={{ fontWeight: 600 }}>{payload.title}</div>
      <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none' }}>
        {payload.items.map((item) => (
          <li
            key={item.id}
            style={{
              borderTop: '1px solid #2a2a4a',
              padding: '6px 0',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                {item.label}
              </div>
              {item.detail && (
                <div style={{ opacity: 0.7, fontSize: 11.5 }}>{item.detail}</div>
              )}
              {item.actions && item.actions.length > 0 && (
                <div style={chipsRowStyle}>
                  {item.actions.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      style={chipStyle(a.variant)}
                      onClick={() => onAction?.(a, item)}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <span style={{
              fontFamily: 'ui-monospace, monospace',
              fontSize: 10.5,
              padding: '2px 6px',
              borderRadius: 6,
              background: '#2a2a4a',
              flexShrink: 0,
            }}>{item.state}</span>
          </li>
        ))}
      </ul>
      {payload.footer && (
        <div style={{ marginTop: 6, opacity: 0.7, fontSize: 11.5 }}>{payload.footer}</div>
      )}
    </div>
  );
}

function ReactCanvasCard({ payload }) {
  // Simple preview for react-canvas in widget
  return (
    <div style={cardBoxStyle}>
      <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, opacity: 0.8 }}>
        {payload.filename || 'Component.tsx'}
      </div>
      <div style={{ marginTop: 4 }}>
        React component preview (shown in dashboard)
      </div>
      <div style={{ marginTop: 6, opacity: 0.9 }}>
        Bundle size: {payload.bundle_size ? (payload.bundle_size / 1024).toFixed(1) + 'kb' : 'N/A'}
      </div>
    </div>
  );
}

// Registry — widget surface only knows these types.
export const WIDGET_RENDERER_REGISTRY = {
  'error-halt': ErrorHaltCard,
  'inline-actions': InlineActionsCard,
  'queue-card': QueueCard,
  'react-canvas': ReactCanvasCard,
};

export function RendererPayloadCard({ payload, registry = WIDGET_RENDERER_REGISTRY, onAction }) {
  const Component = registry[payload.type];
  if (!Component) {
    return (
      <div style={{ ...cardBoxStyle, opacity: 0.7, fontStyle: 'italic' }}>
        (renderer: {payload.type} not supported in widget)
      </div>
    );
  }
  return <Component payload={payload} onAction={onAction} />;
}

// Re-export extractor so ChatDrawer can do `extractFromMessage`.
export { extractRendererPayload };
