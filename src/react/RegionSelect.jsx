import { useState, useEffect, useRef, useCallback } from 'react';
import { takeScreenshot } from './captureUtils.js';

/**
 * RegionSelect — full-viewport overlay for drawing a crop rectangle.
 *
 * Props:
 *   onCapture(screenshotBase64, rect) — called after screenshot, rect may be null
 *   onCancel()                        — called on Escape
 */
export default function RegionSelect({ onCapture, onCancel }) {
  const [dragging, setDragging] = useState(false);
  const [start, setStart] = useState({ x: 0, y: 0 });
  const [rect, setRect] = useState(null);
  const [capturing, setCapturing] = useState(false);

  const overlayRef = useRef(null);

  // Normalise raw start/current into a {x,y,width,height} rect
  const buildRect = useCallback((s, e) => {
    const x = Math.min(s.x, e.x);
    const y = Math.min(s.y, e.y);
    const width = Math.abs(e.x - s.x);
    const height = Math.abs(e.y - s.y);
    return { x, y, width, height };
  }, []);

  const doCapture = useCallback(async (captureRect) => {
    setCapturing(true);
    const screenshot = await takeScreenshot(captureRect || undefined);
    onCapture(screenshot, captureRect || null);
  }, [onCapture]);

  // Keyboard: Enter = full viewport, Escape = cancel
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onCancel();
      } else if (e.key === 'Enter') {
        doCapture(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel, doCapture]);

  const handleMouseDown = (e) => {
    if (capturing) return;
    e.preventDefault();
    const pos = { x: e.clientX, y: e.clientY };
    setStart(pos);
    setRect(null);
    setDragging(true);
  };

  const handleMouseMove = (e) => {
    if (!dragging || capturing) return;
    e.preventDefault();
    const current = { x: e.clientX, y: e.clientY };
    setRect(buildRect(start, current));
  };

  const handleMouseUp = async (e) => {
    if (!dragging || capturing) return;
    e.preventDefault();
    setDragging(false);
    const current = { x: e.clientX, y: e.clientY };
    const finalRect = buildRect(start, current);

    // Ignore micro-drags
    if (finalRect.width < 10 || finalRect.height < 10) {
      setRect(null);
      return;
    }

    setRect(finalRect);
    await doCapture(finalRect);
  };

  // -------------------------------------------------------------------------
  // Styles
  // -------------------------------------------------------------------------
  const overlayStyle = {
    position: 'fixed',
    inset: 0,
    zIndex: 99999,
    cursor: capturing ? 'wait' : 'crosshair',
    userSelect: 'none',
  };

  // Dark background rendered as four rectangles around the selection so the
  // selected region appears as a clear "window". When no rect exists yet we
  // just show the full overlay.
  const hasRect = rect && rect.width >= 10 && rect.height >= 10;

  // Build clip-style using box-shadow trick on the selection div
  const darkFull = {
    position: 'absolute',
    inset: 0,
    background: 'rgba(0,0,0,0.3)',
    pointerEvents: 'none',
  };

  const selectionStyle = hasRect
    ? {
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        boxShadow: '0 0 0 9999px rgba(0,0,0,0.3)',
        border: '2px solid #6366f1',
        pointerEvents: 'none',
        boxSizing: 'border-box',
      }
    : null;

  const labelStyle = hasRect
    ? {
        position: 'absolute',
        left: rect.x,
        top: rect.y + rect.height + 6,
        background: 'rgba(0,0,0,0.75)',
        color: '#fff',
        fontFamily: 'monospace',
        fontSize: '11px',
        padding: '2px 6px',
        borderRadius: '3px',
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      }
    : null;

  const bannerStyle = {
    position: 'absolute',
    top: 12,
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'rgba(0,0,0,0.72)',
    color: '#fff',
    fontFamily: 'sans-serif',
    fontSize: '13px',
    padding: '6px 14px',
    borderRadius: '6px',
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    zIndex: 1,
  };

  const capturingStyle = {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.55)',
    color: '#fff',
    fontFamily: 'sans-serif',
    fontSize: '18px',
    fontWeight: 600,
    letterSpacing: '0.02em',
    pointerEvents: 'none',
  };

  return (
    <div
      ref={overlayRef}
      data-devtool-ignore
      style={overlayStyle}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Dark backdrop — only shown when no selection (selection uses box-shadow) */}
      {!hasRect && <div data-devtool-ignore style={darkFull} />}

      {/* Selection rectangle with box-shadow creating the dark surround */}
      {hasRect && (
        <div data-devtool-ignore style={selectionStyle} />
      )}

      {/* Dimension label */}
      {hasRect && (
        <div data-devtool-ignore style={labelStyle}>
          {rect.width}px x {rect.height}px
        </div>
      )}

      {/* Instruction banner */}
      {!capturing && (
        <div data-devtool-ignore style={bannerStyle}>
          Drag to select area · Enter for full page · Esc to go back
        </div>
      )}

      {/* Capturing feedback */}
      {capturing && (
        <div data-devtool-ignore style={capturingStyle}>
          Capturing...
        </div>
      )}
    </div>
  );
}
