import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth';
import AppIcon from './AppIcon';

const NAV = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
  { to: '/customers', label: 'Customers', icon: 'customers' },
  { to: '/products', label: 'Products', icon: 'products' },
  { to: '/orders', label: 'Orders', icon: 'orders' },
  { to: '/quotes', label: 'Quotes', icon: 'quotes' },
  { to: '/visits', label: 'Visits', icon: 'visits' },
  { to: '/routes', label: 'Routes', icon: 'routes' },
  { to: '/map', label: 'Live map', icon: 'map' },
  { to: '/kpis', label: 'Rep KPIs', icon: 'kpis' },
  { to: '/analytics', label: 'Analytics', icon: 'analytics' },
  { to: '/ai', label: 'Sales AI', icon: 'ai' },
  { to: '/forms', label: 'Forms', icon: 'forms' },
  { to: '/integration', label: 'Integration', icon: 'integration', adminOnly: true },
  { to: '/users', label: 'Users', icon: 'users', adminOnly: true }
];

export default function Layout() {
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const nav = NAV.filter((n) => !n.adminOnly || ['admin', 'manager'].includes(user.role));

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-40 w-60 transform bg-navy-900 text-slate-300 transition-transform lg:static lg:translate-x-0 ${menuOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex items-center gap-2.5 px-5 py-5">
          <img src="/icon-light.svg" alt="" className="h-9 w-9" />
          <div>
            <div className="text-lg font-extrabold leading-none tracking-tight text-white">Route<span className="text-brand-500">One</span></div>
            <div className="mt-1 text-[10px] uppercase tracking-widest text-slate-400">Field Sales</div>
          </div>
        </div>
        <nav className="mt-2 space-y-0.5 px-3">
          {nav.map((n) => (
            <NavLink
              key={n.to} to={n.to} end={n.end}
              onClick={() => setMenuOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-2.5 py-1.5 text-sm font-medium ${isActive ? 'bg-brand-600 text-white' : 'hover:bg-navy-800 hover:text-white'}`}
            >
              <AppIcon name={n.icon} size={28} />{n.label}
            </NavLink>
          ))}
        </nav>
        <div className="absolute bottom-0 w-full border-t border-slate-800 p-4">
          <div className="text-sm font-medium text-white">{user.name}</div>
          <div className="text-xs text-slate-500 capitalize">{user.role}</div>
          <button onClick={logout} className="mt-2 text-xs text-slate-400 hover:text-white">Sign out →</button>
        </div>
      </aside>
      {menuOpen && <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => setMenuOpen(false)} />}

      {/* Main */}
      <div className="flex-1 min-w-0">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
          <button className="lg:hidden btn-secondary px-2.5" onClick={() => setMenuOpen(true)}>☰</button>
          <div className="hidden lg:block text-sm text-slate-400">RouteOne — Field Sales Platform</div>
          <NavLink to="/mobile" className="btn-secondary text-xs">📱 Rep app</NavLink>
        </header>
        <main className="p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
