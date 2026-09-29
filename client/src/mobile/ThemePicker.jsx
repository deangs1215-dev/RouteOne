// Theme selector for the mobile app header. Replaces the old two-state
// light/dark toggle - reps now pick from the full set in mobile/theme.jsx.
import { useEffect, useRef, useState } from 'react';
import { useMobileTheme } from './theme';

export default function ThemePicker() {
  const { theme, setTheme, themes } = useMobileTheme();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const active = themes.find((t) => t.id === theme) || themes[0];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    // pointerdown, not click: the menu must close even when the tap lands on a
    // control that stops the click from propagating.
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const Swatch = ({ colors, size = 'h-3.5 w-3.5' }) => (
    <span className="flex -space-x-1">
      {colors.map((c) => (
        <span
          key={c}
          className={`${size} rounded-full ring-1 ring-black/20`}
          style={{ backgroundColor: c }}
        />
      ))}
    </span>
  );

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Appearance: ${active.name}`}
        className="flex items-center gap-2 rounded-full bg-white/10 px-2.5 py-1.5 text-chrome-ink transition active:scale-95"
      >
        <Swatch colors={active.swatch} />
        <svg viewBox="0 0 20 20" className={`h-3.5 w-3.5 opacity-70 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-card border border-line bg-surface shadow-xl"
        >
          <div className="border-b border-line px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
            Appearance
          </div>
          {themes.map((t) => {
            const selected = t.id === theme;
            return (
              <button
                key={t.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => { setTheme(t.id); setOpen(false); }}
                className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition ${selected ? 'bg-accent-soft' : 'active:bg-raised'}`}
              >
                <Swatch colors={t.swatch} size="h-4 w-4" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{t.name}</span>
                  <span className="block truncate text-[11px] text-muted">{t.description}</span>
                </span>
                {selected && (
                  <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-accent" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M4 10l4 4 8-8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
