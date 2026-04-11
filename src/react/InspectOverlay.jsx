import { useEffect, useRef } from 'react';
import { getComponentInfo } from './captureUtils.js';

/**
 * InspectOverlay — full-viewport transparent overlay that highlights DOM
 * elements on hover and captures React component info on click.
 *
 * Props:
 *   onSelect(componentInfo) — called when the user clicks an element
 *   onCancel()              — called when the user presses Escape
 */
export default function InspectOverlay({ onSelect, onCancel }) {
  const highlightRef = useRef(null);
  const tooltipRef = useRef(null);
  const lastElRef = useRef(null);

  useEffect(() => {
    // Save and override cursor
    const prevCursor = document.body.style.cursor;
    document.body.style.cursor = 'crosshair';

    // Create highlight element
    const highlight = document.createElement('div');
    highlight.setAttribute('data-devtool-ignore', '');
    Object.assign(highlight.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '99999',
      border: '2px solid #ef4444',
      backgroundColor: 'rgba(239,68,68,0.1)',
      borderRadius: '4px',
      transition: 'all 0.05s',
      boxSizing: 'border-box',
      display: 'none',
    });
    document.body.appendChild(highlight);
    highlightRef.current = highlight;

    // Create tooltip element
    const tooltip = document.createElement('div');
    tooltip.setAttribute('data-devtool-ignore', '');
    Object.assign(tooltip.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '100000',
      backgroundColor: '#1e1e2e',
      color: '#ef4444',
      fontFamily: 'monospace',
      fontSize: '12px',
      padding: '4px 8px',
      border: '1px solid #ef4444',
      borderRadius: '6px',
      display: 'none',
      whiteSpace: 'nowrap',
    });
    document.body.appendChild(tooltip);
    tooltipRef.current = tooltip;

    // -----------------------------------------------------------------------
    // mousemove handler (capture phase)
    // -----------------------------------------------------------------------
    function onMouseMove(e) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el) return;

      // Skip devtool elements
      if (el.closest('[data-devtool-ignore]')) {
        highlight.style.display = 'none';
        tooltip.style.display = 'none';
        lastElRef.current = null;
        return;
      }

      lastElRef.current = el;

      // Position highlight over the element
      const rect = el.getBoundingClientRect();
      Object.assign(highlight.style, {
        display: 'block',
        top: rect.top + 'px',
        left: rect.left + 'px',
        width: rect.width + 'px',
        height: rect.height + 'px',
      });

      // Get component name for tooltip
      const info = getComponentInfo(el);
      tooltip.textContent = `<${info.name}>`;
      Object.assign(tooltip.style, {
        display: 'block',
        top: e.clientY + 16 + 'px',
        left: e.clientX + 12 + 'px',
      });
    }

    // -----------------------------------------------------------------------
    // click handler (capture phase)
    // -----------------------------------------------------------------------
    function onClick(e) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el) return;
      if (el.closest('[data-devtool-ignore]')) return;

      e.preventDefault();
      e.stopPropagation();

      const info = getComponentInfo(el);
      onSelect(info);
    }

    // -----------------------------------------------------------------------
    // keydown handler — Escape cancels
    // -----------------------------------------------------------------------
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        onCancel();
      }
    }

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);

      document.body.style.cursor = prevCursor;

      if (highlightRef.current) {
        highlightRef.current.remove();
        highlightRef.current = null;
      }
      if (tooltipRef.current) {
        tooltipRef.current.remove();
        tooltipRef.current = null;
      }
    };
  }, [onSelect, onCancel]);

  return (
    <>
      {/* Full-viewport transparent overlay — pointer events disabled so
          elementFromPoint resolves the actual page element underneath */}
      <div
        data-devtool-ignore=""
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 99998,
          pointerEvents: 'none',
        }}
      />

      {/* Instruction banner — pointer events enabled so it doesn't block
          clicks on itself, but it carries data-devtool-ignore so the
          mousemove handler skips it */}
      <div
        data-devtool-ignore=""
        style={{
          position: 'fixed',
          top: 16,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 100001,
          backgroundColor: '#1e1e2e',
          color: '#cdd6f4',
          fontFamily: 'monospace',
          fontSize: '13px',
          padding: '8px 16px',
          borderRadius: '8px',
          border: '1px solid #ef4444',
          pointerEvents: 'auto',
          userSelect: 'none',
          whiteSpace: 'nowrap',
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        }}
      >
        Click any element to inspect&nbsp;&nbsp;·&nbsp;&nbsp;
        <span style={{ color: '#ef4444' }}>Esc</span> to cancel
      </div>
    </>
  );
}
