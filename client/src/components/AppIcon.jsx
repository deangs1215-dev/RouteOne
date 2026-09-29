// Premium "app tile" icons: a rounded gradient square with a top gloss, a soft
// floating drop-shadow, and a white glyph themed to each destination.
// Usage: <AppIcon name="customers" size={26} />
import { useId } from 'react';

// Per-destination gradient [topColour, bottomColour].
const GRAD = {
  dashboard:   ['#33b0d8', '#1a7ea8'],
  customers:   ['#4f93f6', '#2c66e0'],
  products:    ['#f7ad4b', '#e8842a'],
  orders:      ['#39cd83', '#1f9d5b'],
  quotes:      ['#8090f7', '#4f5fd0'],
  visits:      ['#f76d6d', '#e03e3e'],
  routes:      ['#33d6b4', '#16a085'],
  map:         ['#3cb8f6', '#1f8fd8'],
  kpis:        ['#ab72f6', '#7d3ee0'],
  analytics:   ['#f76db4', '#d63e8c'],
  ai:          ['#9b6cf6', '#6d28d9'],
  forms:       ['#6f90ba', '#47688f'],
  documents:   ['#e8a23c', '#c97f1a'],
  integration: ['#2fd3ca', '#1a9e97'],
  users:       ['#7c8aa0', '#3f4d63'],
  today:       ['#f79a3c', '#e5701f'],
  shop:        ['#2aa5d0', '#1a7ea8'],
  account:     ['#5aa9c9', '#3577a0'],
  support:     ['#f76d6d', '#d33a3a']
};

const DARK = 'rgba(0,0,0,0.2)'; // engraved detail lines/cut-outs

function Glyph({ name }) {
  switch (name) {
    case 'customers':
      return (
        <>
          <circle cx="18.5" cy="19" r="4.2" />
          <circle cx="29.5" cy="19" r="4.2" />
          <path d="M11 34c0-4.2 3.4-7 7.5-7 1.6 0 3 .4 4.2 1.1C23.9 27.4 25.3 27 27 27c4.1 0 7.5 2.8 7.5 7 0 .6-.4 1-1 1H12c-.6 0-1-.4-1-1z" />
        </>
      );
    case 'products':
      return (
        <>
          <path d="M24 11l11 5.5v15L24 37l-11-5.5v-15z" />
          <path d="M13 16.5l11 5.5 11-5.5M24 22v15" fill="none" stroke={DARK} strokeWidth="1.6" strokeLinejoin="round" />
        </>
      );
    case 'orders':
      return (
        <>
          <path d="M15 12h18a1 1 0 0 1 1 1v23l-3.2-2.2-3.3 2.2-3.3-2.2-3.2 2.2-3.3-2.2L15 36V13a1 1 0 0 1 1-1z" />
          <path d="M19 19h10M19 24h10M19 29h6" stroke={DARK} strokeWidth="1.7" strokeLinecap="round" />
        </>
      );
    case 'quotes':
      return (
        <>
          <path d="M16 11h11l6 6v19a1 1 0 0 1-1 1H16a1 1 0 0 1-1-1V12a1 1 0 0 1 1-1z" />
          <path d="M27 11v6h6" fill="none" stroke={DARK} strokeWidth="1.6" />
          <path d="M20 24h8M20 29h5" stroke={DARK} strokeWidth="1.7" strokeLinecap="round" />
        </>
      );
    case 'visits':
      return (
        <>
          <path d="M24 11c-5.5 0-10 4.3-10 9.7 0 6.9 8.4 14.9 9.3 15.8.4.4 1 .4 1.4 0 .9-.9 9.3-8.9 9.3-15.8C34 15.3 29.5 11 24 11z" />
          <circle cx="24" cy="20.5" r="3.8" fill={DARK} />
        </>
      );
    case 'routes':
      return (
        <>
          <path d="M16 33c9 0 0-18 16-18" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeDasharray="0.5 5" />
          <circle cx="16" cy="33" r="3.4" />
          <circle cx="32" cy="15" r="3.4" />
        </>
      );
    case 'map':
      return (
        <>
          <circle cx="24" cy="24" r="12" />
          <g fill="none" stroke={DARK} strokeWidth="1.5">
            <path d="M12 24h24" />
            <path d="M24 12v24" />
            <path d="M24 12c-6 4.5-6 19.5 0 24" />
            <path d="M24 12c6 4.5 6 19.5 0 24" />
          </g>
        </>
      );
    case 'kpis':
      return (
        <>
          <rect x="13" y="25" width="6" height="11" rx="1.5" />
          <rect x="21" y="18" width="6" height="18" rx="1.5" />
          <rect x="29" y="22" width="6" height="14" rx="1.5" />
        </>
      );
    case 'analytics':
      return (
        <>
          <path d="M13 34h22" stroke="#fff" strokeOpacity="0.5" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M14 30l6-6 5 4 9-11" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="34" cy="17" r="2.6" />
        </>
      );
    case 'ai':
      return (
        <>
          <path d="M23 12 L25.8 18.2 L32 21 L25.8 23.8 L23 30 L20.2 23.8 L14 21 L20.2 18.2 Z" />
          <path d="M32 26 L33.2 28.8 L36 30 L33.2 31.2 L32 34 L30.8 31.2 L28 30 L30.8 28.8 Z" />
        </>
      );
    case 'forms':
      return (
        <>
          <rect x="14" y="14" width="20" height="22" rx="3" />
          <rect x="19" y="11.5" width="10" height="5.5" rx="2.2" fill={DARK} />
          <path d="M18.5 23h11M18.5 28h11M18.5 32h7" stroke={DARK} strokeWidth="1.7" strokeLinecap="round" />
        </>
      );
    case 'documents':
      return (
        <>
          <path d="M12 17.5a3 3 0 0 1 3-3h6l3 3h11a3 3 0 0 1 3 3v11a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3z" />
          <path d="M12 17.5h24" stroke={DARK} strokeWidth="1.4" />
        </>
      );
    case 'integration':
      return (
        <>
          <circle cx="20" cy="24" r="6.5" fill="none" stroke="#fff" strokeWidth="3.2" />
          <circle cx="28" cy="24" r="6.5" fill="none" stroke="#fff" strokeWidth="3.2" />
        </>
      );
    case 'users':
      return (
        <>
          {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
            <rect key={a} x="22" y="10.5" width="4" height="5" rx="1.4" transform={`rotate(${a} 24 24)`} />
          ))}
          <circle cx="24" cy="24" r="8" />
          <circle cx="24" cy="24" r="3.4" fill={DARK} />
        </>
      );
    case 'today':
      return (
        <>
          <rect x="13" y="14" width="22" height="21" rx="3" />
          <path d="M13 20h22" stroke={DARK} strokeWidth="1.8" />
          <rect x="18" y="11" width="2.6" height="6" rx="1.3" />
          <rect x="27.4" y="11" width="2.6" height="6" rx="1.3" />
          <g fill={DARK}>
            <circle cx="20" cy="26" r="1.7" />
            <circle cx="24" cy="26" r="1.7" />
            <circle cx="28" cy="26" r="1.7" />
          </g>
        </>
      );
    case 'shop':
      return (
        <>
          <path d="M13 14h3l2.2 12.5a2 2 0 0 0 2 1.7h9.4a2 2 0 0 0 2-1.6L35 18H18" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="21" cy="33" r="2.3" />
          <circle cx="31" cy="33" r="2.3" />
        </>
      );
    case 'account':
      return (
        <>
          <circle cx="24" cy="18.5" r="5.2" />
          <path d="M13 34.5c0-5.4 4.7-9 11-9s11 3.6 11 9c0 .6-.4 1-1 1H14c-.6 0-1-.4-1-1z" />
        </>
      );
    case 'support':
      return (
        <>
          <circle cx="24" cy="24" r="12" fill="none" stroke="#fff" strokeWidth="3" />
          <circle cx="24" cy="24" r="3.4" fill={DARK} />
          <g stroke="#fff" strokeWidth="3" strokeLinecap="round">
            <path d="M24 12v3.6M24 32.4V36M12 24h3.6M32.4 24H36" />
          </g>
        </>
      );
    case 'dashboard':
    default:
      return (
        <>
          <rect x="12" y="12" width="9" height="9" rx="2.5" />
          <rect x="27" y="12" width="9" height="9" rx="2.5" />
          <rect x="12" y="27" width="9" height="9" rx="2.5" />
          <rect x="27" y="27" width="9" height="9" rx="2.5" />
        </>
      );
  }
}

export default function AppIcon({ name, size = 26 }) {
  const uid = useId().replace(/:/g, '');
  const [c0, c1] = GRAD[name] || GRAD.dashboard;
  const fillId = `af${uid}`;
  const glossId = `ag${uid}`;
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true"
      style={{ filter: 'drop-shadow(0 2px 3px rgba(10,20,40,0.35))', flexShrink: 0 }}>
      <defs>
        <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={c0} />
          <stop offset="1" stopColor={c1} />
        </linearGradient>
        <linearGradient id={glossId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.5" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.04" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="3" y="3" width="42" height="42" rx="11.5" fill={`url(#${fillId})`} />
      <rect x="3" y="3" width="42" height="42" rx="11.5" fill={`url(#${glossId})`} />
      <rect x="3.6" y="3.6" width="40.8" height="40.8" rx="11" fill="none" stroke="#fff" strokeOpacity="0.4" strokeWidth="1" />
      <g fill="#fff"><Glyph name={name} /></g>
    </svg>
  );
}
