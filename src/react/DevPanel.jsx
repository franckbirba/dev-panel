import React, { useState } from 'react';

const PANEL_TYPES = {
  BUG: 'bug',
  FEATURE: 'feature'
};

export function DevPanel({ apiUrl = 'http://localhost:3030', project = 'unknown' }) {
  const [isOpen, setIsOpen] = useState(false);
  const [activePanel, setActivePanel] = useState(null);
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    screenshot: null
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState(null);

  const handleSubmit = async (type) => {
    if (!formData.title || !formData.description) {
      alert('Please fill in title and description');
      return;
    }

    setIsSubmitting(true);
    setSubmitStatus(null);

    try {
      const formPayload = new FormData();
      formPayload.append('type', type);
      formPayload.append('title', formData.title);
      formPayload.append('description', formData.description);
      formPayload.append('project', project);
      formPayload.append('created_by', 'user@example.com'); // TODO: Get from auth

      // Capture context
      const context = {
        url: window.location.href,
        userAgent: navigator.userAgent,
        timestamp: Date.now(),
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        }
      };
      formPayload.append('context', JSON.stringify(context));

      // Add screenshot if provided
      if (formData.screenshot) {
        formPayload.append('screenshot', formData.screenshot);
      }

      const response = await fetch(`${apiUrl}/api/tickets`, {
        method: 'POST',
        body: formPayload
      });

      if (!response.ok) {
        throw new Error('Failed to submit ticket');
      }

      const result = await response.json();

      setSubmitStatus({ type: 'success', message: `Ticket #${result.id} created successfully!` });

      // Reset form
      setFormData({ title: '', description: '', screenshot: null });

      // Close panel after 2 seconds
      setTimeout(() => {
        setActivePanel(null);
        setSubmitStatus(null);
      }, 2000);

    } catch (error) {
      console.error('Error submitting ticket:', error);
      setSubmitStatus({ type: 'error', message: error.message });
    } finally {
      setIsSubmitting(false);
    }
  };

  const captureScreenshot = async () => {
    try {
      // Use html2canvas or similar in production
      // For now, just allow file upload
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
          setFormData(prev => ({ ...prev, screenshot: file }));
        }
      };
      input.click();
    } catch (error) {
      console.error('Error capturing screenshot:', error);
    }
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        style={{
          position: 'fixed',
          bottom: '20px',
          right: '20px',
          width: '60px',
          height: '60px',
          borderRadius: '50%',
          backgroundColor: '#6366f1',
          color: 'white',
          border: 'none',
          cursor: 'pointer',
          boxShadow: '0 4px 12px rgba(99, 102, 241, 0.4)',
          fontSize: '24px',
          zIndex: 9999,
          transition: 'transform 0.2s',
        }}
        onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.1)'}
        onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
      >
        🐛
      </button>
    );
  }

  return (
    <div style={{
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      zIndex: 9999,
      fontFamily: 'system-ui, -apple-system, sans-serif'
    }}>
      {/* Main Panel */}
      {!activePanel && (
        <div style={{
          backgroundColor: 'white',
          borderRadius: '12px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
          padding: '20px',
          width: '280px'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '600' }}>Dev Panel</h3>
            <button
              onClick={() => setIsOpen(false)}
              style={{
                background: 'none',
                border: 'none',
                fontSize: '20px',
                cursor: 'pointer',
                padding: '4px',
                color: '#666'
              }}
            >
              ×
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <button
              onClick={() => setActivePanel(PANEL_TYPES.BUG)}
              style={{
                padding: '12px 16px',
                backgroundColor: '#ef4444',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: '500',
                transition: 'opacity 0.2s'
              }}
              onMouseEnter={(e) => e.currentTarget.style.opacity = '0.9'}
              onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
            >
              🐛 Report Bug
            </button>

            <button
              onClick={() => setActivePanel(PANEL_TYPES.FEATURE)}
              style={{
                padding: '12px 16px',
                backgroundColor: '#10b981',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: '500',
                transition: 'opacity 0.2s'
              }}
              onMouseEnter={(e) => e.currentTarget.style.opacity = '0.9'}
              onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
            >
              💡 Request Feature
            </button>
          </div>
        </div>
      )}

      {/* Bug/Feature Form */}
      {activePanel && (
        <div style={{
          backgroundColor: 'white',
          borderRadius: '12px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
          padding: '20px',
          width: '400px',
          maxHeight: '600px',
          overflowY: 'auto'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '600' }}>
              {activePanel === PANEL_TYPES.BUG ? '🐛 Report Bug' : '💡 Request Feature'}
            </h3>
            <button
              onClick={() => setActivePanel(null)}
              style={{
                background: 'none',
                border: 'none',
                fontSize: '20px',
                cursor: 'pointer',
                padding: '4px',
                color: '#666'
              }}
            >
              ←
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
              <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: '500' }}>
                Title *
              </label>
              <input
                type="text"
                value={formData.title}
                onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
                placeholder={activePanel === PANEL_TYPES.BUG ? 'Brief description of the bug' : 'Feature you want to request'}
                style={{
                  width: '100%',
                  padding: '10px',
                  border: '1px solid #d1d5db',
                  borderRadius: '6px',
                  fontSize: '14px',
                  boxSizing: 'border-box'
                }}
              />
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: '500' }}>
                Description *
              </label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                placeholder={
                  activePanel === PANEL_TYPES.BUG
                    ? 'What happened? What did you expect to happen?'
                    : 'Describe the feature and why it would be useful'
                }
                rows={6}
                style={{
                  width: '100%',
                  padding: '10px',
                  border: '1px solid #d1d5db',
                  borderRadius: '6px',
                  fontSize: '14px',
                  resize: 'vertical',
                  fontFamily: 'inherit',
                  boxSizing: 'border-box'
                }}
              />
            </div>

            {activePanel === PANEL_TYPES.BUG && (
              <div>
                <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: '500' }}>
                  Screenshot (optional)
                </label>
                <button
                  onClick={captureScreenshot}
                  style={{
                    padding: '10px 16px',
                    backgroundColor: formData.screenshot ? '#10b981' : '#6366f1',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '14px',
                    width: '100%'
                  }}
                >
                  {formData.screenshot ? '✓ Screenshot attached' : '📸 Attach screenshot'}
                </button>
              </div>
            )}

            {submitStatus && (
              <div style={{
                padding: '12px',
                borderRadius: '6px',
                backgroundColor: submitStatus.type === 'success' ? '#d1fae5' : '#fee2e2',
                color: submitStatus.type === 'success' ? '#065f46' : '#991b1b',
                fontSize: '14px'
              }}>
                {submitStatus.message}
              </div>
            )}

            <button
              onClick={() => handleSubmit(activePanel)}
              disabled={isSubmitting}
              style={{
                padding: '12px 16px',
                backgroundColor: isSubmitting ? '#9ca3af' : '#6366f1',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
                fontSize: '14px',
                fontWeight: '500',
                transition: 'opacity 0.2s'
              }}
            >
              {isSubmitting ? 'Submitting...' : 'Submit'}
            </button>

            <p style={{ fontSize: '12px', color: '#6b7280', margin: 0, textAlign: 'center' }}>
              Your report will be reviewed by the team
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
