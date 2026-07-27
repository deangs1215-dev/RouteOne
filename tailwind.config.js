/** @type {import('tailwindcss').Config} */
export default {
  content: ['./client/index.html', './client/src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
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
