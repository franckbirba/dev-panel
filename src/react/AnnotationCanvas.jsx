import { useState, useEffect, useRef, useCallback } from 'react';

const TOOLS = { ARROW: 'arrow', CIRCLE: 'circle', TEXT: 'text' };
const COLORS = ['#ef4444', '#facc15', '#3b82f6'];

/**
 * AnnotationCanvas — draw arrows, circles, and text on a captured screenshot.
 *
 * Props:
 *   screenshot (string)              — base64 image to annotate
 *   onDone(annotatedScreenshot)      — called with final base64 JPEG (quality 0.8)
 *   onCancel()                       — back to region-select
 */
export default function AnnotationCanvas({ screenshot, onDone, onCancel }) {
  const [tool, setTool] = useState(TOOLS.ARROW);
  const [color, setColor] = useState(COLORS[0]);
  const [annotations, setAnnotations] = useState([]);
  const [drawing, setDrawing] = useState(null);
  const [textInput, setTextInput] = useState(null); // {x, y} or null
  const [imgLoaded, setImgLoaded] = useState(false);

  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const textInputRef = useRef(null);

  // Load the screenshot image
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setImgLoaded(true);
    };
    img.src = screenshot;
  }, [screenshot]);

  // Redraw canvas whenever annotations, drawing, or imgLoaded changes
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imgRef.current) return;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(imgRef.current, 0, 0);

    const drawAnnotation = (ann) => {
      ctx.strokeStyle = ann.color;
      ctx.fillStyle = ann.color;
      ctx.lineWidth = 3;

      if (ann.type === TOOLS.ARROW) {
        const { x1, y1, x2, y2 } = ann;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        // Arrowhead
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const headLen = 15;
        const headAngle = Math.PI / 6;
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(
          x2 - headLen * Math.cos(angle - headAngle),
          y2 - headLen * Math.sin(angle - headAngle)
        );
        ctx.moveTo(x2, y2);
        ctx.lineTo(
          x2 - headLen * Math.cos(angle + headAngle),
          y2 - headLen * Math.sin(angle + headAngle)
        );
        ctx.stroke();
      } else if (ann.type === TOOLS.CIRCLE) {
        const { cx, cy, radius } = ann;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(1, radius), 0, 2 * Math.PI);
        ctx.stroke();
      } else if (ann.type === TOOLS.TEXT) {
        ctx.font = 'bold 16px system-ui, sans-serif';
        ctx.fillText(ann.text, ann.x, ann.y);
      }
    };

    annotations.forEach(drawAnnotation);
    if (drawing) drawAnnotation(drawing);
  }, [annotations, drawing, imgLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Set canvas dimensions once image is loaded
  useEffect(() => {
    if (!imgLoaded || !imgRef.current || !canvasRef.current) return;
    canvasRef.current.width = imgRef.current.naturalWidth;
    canvasRef.current.height = imgRef.current.naturalHeight;
    redraw();
  }, [imgLoaded, redraw]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  // Focus text input when it appears
  useEffect(() => {
    if (textInput && textInputRef.current) {
      textInputRef.current.focus();
    }
  }, [textInput]);

  // Keyboard: Escape = cancel
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && !textInput) {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel, textInput]);

  // Translate mouse coords to canvas coords accounting for CSS scaling
  const getCanvasCoords = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  const handleMouseDown = (e) => {
    if (textInput) return;
    const { x, y } = getCanvasCoords(e);

    if (tool === TOOLS.TEXT) {
      setTextInput({ x, y });
      return;
    }

    if (tool === TOOLS.ARROW) {
      setDrawing({ type: TOOLS.ARROW, color, x1: x, y1: y, x2: x, y2: y });
    } else if (tool === TOOLS.CIRCLE) {
      setDrawing({ type: TOOLS.CIRCLE, color, cx: x, cy: y, radius: 0 });
    }
  };

  const handleMouseMove = (e) => {
    if (!drawing) return;
    const { x, y } = getCanvasCoords(e);

    if (drawing.type === TOOLS.ARROW) {
      setDrawing((prev) => ({ ...prev, x2: x, y2: y }));
    } else if (drawing.type === TOOLS.CIRCLE) {
      const radius = Math.hypot(x - drawing.cx, y - drawing.cy);
      setDrawing((prev) => ({ ...prev, radius }));
    }
  };

  const handleMouseUp = () => {
    if (!drawing) return;
    setAnnotations((prev) => [...prev, drawing]);
    setDrawing(null);
  };

  const handleTextSubmit = (value) => {
    if (value.trim() && textInput) {
      setAnnotations((prev) => [
        ...prev,
        { type: TOOLS.TEXT, color, text: value.trim(), x: textInput.x, y: textInput.y },
      ]);
    }
    setTextInput(null);
  };

  const handleUndo = () => {
    setAnnotations((prev) => prev.slice(0, -1));
  };

  const handleDone = () => {
    redraw();
    setTimeout(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      onDone(dataUrl);
    }, 50);
  };

  // -------------------------------------------------------------------------
  // Styles
  // -------------------------------------------------------------------------
  const containerStyle = {
    position: 'fixed',
    inset: 0,
    zIndex: 99999,
    background: '#111',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    userSelect: 'none',
  };

  const toolbarStyle = {
    position: 'absolute',
    top: 12,
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: 'rgba(30,30,30,0.95)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 10,
    padding: '6px 10px',
    zIndex: 1,
  };

  const separatorStyle = {
    width: 1,
    height: 24,
    background: 'rgba(255,255,255,0.18)',
    margin: '0 4px',
  };

  const toolBtnStyle = (active) => ({
    width: 36,
    height: 36,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: active ? '2px solid #6366f1' : '2px solid transparent',
    borderRadius: 7,
    background: active ? 'rgba(99,102,241,0.15)' : 'transparent',
    color: '#fff',
    cursor: 'pointer',
    fontSize: 16,
    transition: 'border-color 0.15s, background 0.15s',
  });

  const colorDotStyle = (c, selected) => ({
    width: 28,
    height: 28,
    borderRadius: '50%',
    background: c,
    border: selected ? '2px solid #fff' : '2px solid transparent',
    cursor: 'pointer',
    boxSizing: 'border-box',
    transition: 'border-color 0.15s',
  });

  const undoBtnStyle = {
    width: 36,
    height: 36,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '2px solid transparent',
    borderRadius: 7,
    background: 'transparent',
    color: '#fff',
    cursor: 'pointer',
    fontSize: 18,
  };

  const doneBtnStyle = {
    height: 32,
    padding: '0 14px',
    background: '#10b981',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 13,
  };

  const cancelBtnStyle = {
    height: 32,
    padding: '0 14px',
    background: 'rgba(255,255,255,0.08)',
    color: '#fff',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
  };

  const canvasWrapStyle = {
    position: 'relative',
    maxWidth: '90vw',
    maxHeight: '80vh',
    overflow: 'auto',
    marginTop: 60,
  };

  const canvasStyle = {
    display: 'block',
    maxWidth: '100%',
    cursor: tool === TOOLS.TEXT ? 'text' : 'crosshair',
  };

  // Text input positioned over canvas in canvas-pixel coords, scaled back to CSS
  const getTextInputStyle = () => {
    if (!textInput || !canvasRef.current) return {};
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / canvas.width;
    const scaleY = rect.height / canvas.height;
    const cssX = textInput.x * scaleX + rect.left;
    const cssY = textInput.y * scaleY + rect.top;
    return {
      position: 'fixed',
      left: cssX,
      top: cssY,
      transform: 'translateY(-50%)',
      zIndex: 100000,
      background: 'rgba(20,20,20,0.92)',
      border: `2px solid ${color}`,
      borderRadius: 5,
      color: '#fff',
      fontSize: 15,
      fontWeight: 'bold',
      fontFamily: 'system-ui, sans-serif',
      padding: '4px 8px',
      outline: 'none',
      minWidth: 120,
    };
  };

  return (
    <div data-devtool-ignore style={containerStyle}>
      {/* Toolbar */}
      <div data-devtool-ignore style={toolbarStyle}>
        {/* Tool buttons */}
        <button
          data-devtool-ignore
          style={toolBtnStyle(tool === TOOLS.ARROW)}
          onClick={() => setTool(TOOLS.ARROW)}
          title="Arrow"
        >
          ↗
        </button>
        <button
          data-devtool-ignore
          style={toolBtnStyle(tool === TOOLS.CIRCLE)}
          onClick={() => setTool(TOOLS.CIRCLE)}
          title="Circle"
        >
          ○
        </button>
        <button
          data-devtool-ignore
          style={toolBtnStyle(tool === TOOLS.TEXT)}
          onClick={() => setTool(TOOLS.TEXT)}
          title="Text"
        >
          T
        </button>

        <div data-devtool-ignore style={separatorStyle} />

        {/* Color dots */}
        {COLORS.map((c) => (
          <div
            key={c}
            data-devtool-ignore
            style={colorDotStyle(c, color === c)}
            onClick={() => setColor(c)}
            title={c}
          />
        ))}

        <div data-devtool-ignore style={separatorStyle} />

        {/* Undo */}
        <button
          data-devtool-ignore
          style={undoBtnStyle}
          onClick={handleUndo}
          title="Undo"
        >
          ↩
        </button>

        <div data-devtool-ignore style={separatorStyle} />

        {/* Done & Cancel */}
        <button data-devtool-ignore style={doneBtnStyle} onClick={handleDone}>
          Done
        </button>
        <button data-devtool-ignore style={cancelBtnStyle} onClick={onCancel}>
          Cancel
        </button>
      </div>

      {/* Canvas area */}
      <div data-devtool-ignore style={canvasWrapStyle}>
        <canvas
          data-devtool-ignore
          ref={canvasRef}
          style={canvasStyle}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
        />
      </div>

      {/* Text input overlay */}
      {textInput && (
        <input
          data-devtool-ignore
          ref={textInputRef}
          style={getTextInputStyle()}
          placeholder="Type text…"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              handleTextSubmit(e.target.value);
            } else if (e.key === 'Escape') {
              setTextInput(null);
            }
          }}
          onBlur={(e) => handleTextSubmit(e.target.value)}
        />
      )}
    </div>
  );
}
