/** @type {import('tailwindcss').Config} */

// Semantic colours for the mobile rep app. Each resolves to a CSS custom
// property defined per theme in client/src/index.css, stored as "R G B"
// channels rather than hex so Tailwind's opacity modifiers still work
// (bg-accent/10 for a tinted panel, border-line/60 for a hairline).
//
// Screens reference roles - surface, ink, accent - never a specific colour, so
// adding a theme is a new block of custom properties and no JSX changes at all.
const token = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ['./client/index.html', './client/src/**/*.{js,jsx}'],
  theme: {
    extend: {
      borderRadius: {
        card: 'var(--r-card)',
        control: 'var(--r-control)',
        pill: 'var(--r-pill)'
      },
      boxShadow: {
        card: 'var(--card-shadow)'
      },
      colors: {
        app: token('app'),            // page background
        surface: token('surface'),    // cards
        raised: token('raised'),      // controls sitting on a card
        line: token('line'),          // hairline borders
        ink: token('ink'),            // primary text
        muted: token('muted'),        // secondary text
        faint: token('faint'),        // tertiary text
        accent: {
          DEFAULT: token('accent'),
          ink: token('accent-ink'),   // text/icon sitting on an accent fill
          soft: token('accent-soft')  // tinted accent background
        },
        chrome: {
          DEFAULT: token('chrome'),   // header + bottom nav
          ink: token('chrome-ink')
        },
        ok: token('ok'),
        warn: token('warn'),
        bad: token('bad'),
        // RouteOne brand: teal accent + navy. Matches the logo.
        brand: {
          50: '#ecf6fb', 100: '#cfe8f3', 500: '#2493c0', 600: '#1a7ea8', 700: '#16688a', 900: '#123f56'
        },
        navy: {
          700: '#1d3a5c', 800: '#17304c', 900: '#152a44'
        },
        // Mobile app "dark mode": a deeper, more formal navy + muted brass
        // accent — deliberately distinct from the brand teal used in light mode.
        corp: {
          950: '#0a1220', 900: '#0f1b30', 800: '#16253d', 700: '#1e3252', 600: '#2b4468'
        },
        brass: {
          400: '#c9a463', 500: '#b3904f', 600: '#96763c'
        }
      }
    }
  },
  plugins: []
};
