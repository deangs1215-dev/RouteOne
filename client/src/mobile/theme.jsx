// Mobile app theming. A theme is nothing but a block of CSS custom properties
// in index.css - this file only decides which one is active, writes it to
// <html data-theme>, and remembers the choice.
//
// Adding a look means adding a block there and an entry here. Screens are
// written against roles (surface, ink, accent), so they need no changes.
import { createContext, useContext, useEffect, useState } from 'react';

// `dark` is not styling - the tokens handle that. It is for the few places
// that still need to know the mood, e.g. choosing an illustration or a map
// tile set, and for screens not yet converted to tokens.
export const THEMES = [
  {
    id: 'light',
    name: 'Daylight',
    description: 'The original light palette',
    dark: false,
    // Swatches are what the picker previews: [ground, surface, accent].
    swatch: ['#f1f5f9', '#ffffff', '#1a7ea8']
  },
  {
    id: 'navy',
    name: 'Corporate Navy',
    description: 'Deep navy with a brass accent',
    dark: true,
    swatch: ['#0a1220', '#0f1b30', '#c9a463']
  },
  {
    id: 'smart-home',
    name: 'Smart Home',
    description: 'Near-black with a vivid orange accent',
    dark: true,
    swatch: ['#181920', '#26282e', '#e2661c']
  },
  {
    id: 'sneaker',
    name: 'Sneaker Market',
    description: 'Bright white, heavy type, hot orange',
    dark: false,
    swatch: ['#f4f4f5', '#ffffff', '#fa6024']
  }
];

const DEFAULT_THEME = 'light';
const STORAGE_KEY = 'mobile_theme';
const MobileThemeContext = createContext(null);

// Earlier builds stored only 'light' or 'dark' under this same key; 'dark' was
// the navy palette, so it maps forward rather than silently resetting a rep to
// the light theme on their next visit.
function readStoredTheme() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'dark') return 'navy';
  return THEMES.some((t) => t.id === stored) ? stored : DEFAULT_THEME;
}

export function MobileThemeProvider({ children }) {
  const [theme, setTheme] = useState(readStoredTheme);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, theme);
    // Set on <html>, not on a wrapper div: the tokens then also cover the body
    // (overscroll) and anything rendered at the top of the stacking context.
    // Removed on unmount so the desktop app is never left themed.
    document.documentElement.setAttribute('data-theme', theme);
    return () => document.documentElement.removeAttribute('data-theme');
  }, [theme]);

  const current = THEMES.find((t) => t.id === theme) || THEMES[0];
  return (
    <MobileThemeContext.Provider value={{ theme, setTheme, themes: THEMES, isDark: current.dark }}>
      {children}
    </MobileThemeContext.Provider>
  );
}

export function useMobileTheme() {
  return useContext(MobileThemeContext);
}
