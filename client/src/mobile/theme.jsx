// Mobile app light/dark toggle. "Dark" is the corporate navy + brass palette
// (what used to be a separate "v2"); the toggle lives in the header, top
// right, on every screen. Persisted so it sticks across visits.
import { createContext, useContext, useEffect, useState } from 'react';

const MobileThemeContext = createContext(null);

export function MobileThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => localStorage.getItem('mobile_theme') || 'light');
  useEffect(() => { localStorage.setItem('mobile_theme', theme); }, [theme]);
  const toggleTheme = () => setTheme((t) => (t === 'light' ? 'dark' : 'light'));
  return (
    <MobileThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </MobileThemeContext.Provider>
  );
}

export function useMobileTheme() {
  return useContext(MobileThemeContext);
}
