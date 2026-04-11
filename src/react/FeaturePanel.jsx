import React, { useState } from 'react';

const slideInStyle = `
@keyframes devpanel-slide-in {
  from { transform: translateX(100%); }
  to   { transform: translateX(0); }
}
`;

export function FeaturePanel({ onSubmit, onCancel, submitting }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  const canSubmit = title.trim() && description.trim() && !submitting;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit(title, description);
  };

  return (
    <>
      <style data-devtool-ignore>{slideInStyle}</style>
      <div
        data-devtool-ignore
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: '400px',
          zIndex: 99999,
          backgroundColor: '#1a1a2e',
          color: '#e0e0e0',
          boxShadow: '-4px 0 24px rgba(0,0,0,0.4)',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          animation: 'devpanel-slide-in 0.25s ease-out',
        }}
      >
        {/* Header */}
        <div
          data-devtool-ignore
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid #2a2a4a',
          }}
        >
          <span data-devtool-ignore style={{ fontWeight: 600, fontSize: '15px' }}>
            💡 Feature Request
          </span>
          <button
            data-devtool-ignore
            onClick={onCancel}
            style={{
              background: 'none',
              border: 'none',
              color: '#888',
              fontSize: '20px',
              cursor: 'pointer',
              padding: '4px',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div
          data-devtool-ignore
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
          }}
        >
          {/* Title field */}
          <div data-devtool-ignore>
            <label
              data-devtool-ignore
              style={{
                display: 'block',
                marginBottom: '6px',
                fontSize: '13px',
                fontWeight: 500,
                color: '#e0e0e0',
              }}
            >
              Title *
            </label>
            <input
              data-devtool-ignore
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Feature you want to request"
              style={{
                width: '100%',
                padding: '10px',
                backgroundColor: '#16213e',
                border: '1px solid #333',
                borderRadius: '6px',
                color: '#e0e0e0',
                fontSize: '13px',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Description field */}
          <div data-devtool-ignore>
            <label
              data-devtool-ignore
              style={{
                display: 'block',
                marginBottom: '6px',
                fontSize: '13px',
                fontWeight: 500,
                color: '#e0e0e0',
              }}
            >
              Description *
            </label>
            <textarea
              data-devtool-ignore
              rows={8}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the feature and why it would be useful"
              style={{
                width: '100%',
                padding: '10px',
                backgroundColor: '#16213e',
                border: '1px solid #333',
                borderRadius: '6px',
                color: '#e0e0e0',
                fontSize: '13px',
                boxSizing: 'border-box',
                resize: 'vertical',
              }}
            />
          </div>
        </div>

        {/* Footer */}
        <div
          data-devtool-ignore
          style={{
            display: 'flex',
            gap: '10px',
            padding: '16px 20px',
            borderTop: '1px solid #2a2a4a',
          }}
        >
          <button
            data-devtool-ignore
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{
              flex: 1,
              padding: '10px 16px',
              backgroundColor: canSubmit ? '#6366f1' : '#333',
              color: '#e0e0e0',
              border: 'none',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: 500,
              cursor: canSubmit ? 'pointer' : 'not-allowed',
            }}
          >
            Submit Feature
          </button>
          <button
            data-devtool-ignore
            onClick={onCancel}
            style={{
              flex: 1,
              padding: '10px 16px',
              backgroundColor: '#333',
              color: '#888',
              border: 'none',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}
