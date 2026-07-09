import { useRef, useState, useEffect } from 'react';

export default function SignatureCapture({ onSave, onCancel, label = 'Sign here' }) {
  const canvasRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [ctx, setCtx] = useState(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Set canvas size to match display size
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;

    const context = canvas.getContext('2d');
    context.strokeStyle = '#152a44';
    context.lineWidth = 2;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    setCtx(context);
  }, []);

  const startDrawing = (e) => {
    if (!ctx) return;
    setIsDrawing(true);
    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.touches?.[0] || e).clientX - rect.left;
    const y = (e.touches?.[0] || e).clientY - rect.top;
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const draw = (e) => {
    if (!isDrawing || !ctx) return;
    e.preventDefault();
    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.touches?.[0] || e).clientX - rect.left;
    const y = (e.touches?.[0] || e).clientY - rect.top;
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const stopDrawing = () => {
    if (ctx) ctx.closePath();
    setIsDrawing(false);
  };

  const clear = () => {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
  };

  const save = () => {
    const dataUrl = canvasRef.current.toDataURL('image/png');
    onSave(dataUrl);
  };

  return (
    <div className="space-y-3">
      <div className="text-sm font-semibold text-slate-700">{label}</div>
      <div className="border-2 border-dashed border-slate-300 rounded-lg bg-white overflow-hidden">
        <canvas
          ref={canvasRef}
          onMouseDown={startDrawing}
          onMouseMove={draw}
          onMouseUp={stopDrawing}
          onMouseLeave={stopDrawing}
          onTouchStart={startDrawing}
          onTouchMove={draw}
          onTouchEnd={stopDrawing}
          className="w-full h-32 cursor-crosshair bg-white"
          style={{ touchAction: 'none' }}
        />
      </div>
      <div className="flex gap-2">
        <button onClick={clear} className="btn-secondary flex-1 py-2 text-sm">
          Clear
        </button>
        <button onClick={save} className="btn-primary flex-1 py-2 text-sm">
          Confirm signature
        </button>
        <button onClick={onCancel} className="btn-secondary flex-1 py-2 text-sm">
          Cancel
        </button>
      </div>
    </div>
  );
}
