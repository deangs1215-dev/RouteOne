import { useState, useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth';
import AppIcon from './AppIcon';

const NAV = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
  { to: '/customers', label: 'Customers', icon: 'customers' },
  { to: '/products', label: 'Products', icon: 'products' },
  { to: '/orders', label: 'Orders', icon: 'orders' },
  { to: '/quotes', label: 'Quotes', icon: 'quotes' },
  { to: '/invoices', label: 'Invoices', icon: 'quotes' },
  { to: '/visits', label: 'Visits', icon: 'visits' },
  { to: '/routes', label: 'Routes', icon: 'routes' },
  { to: '/map', label: 'Live map', icon: 'map', repHidden: true },
  { to: '/team', label: 'Team', icon: 'kpis', roles: ['admin'] },
  { to: '/tasks', label: 'Tasks', icon: 'tasks' },
  { to: '/support', label: 'Support Tickets', icon: 'support' },
  { to: '/kpis', label: 'Rep KPIs', icon: 'kpis' },
  { to: '/analytics', label: 'Analytics', icon: 'analytics' },
  { to: '/ai', label: 'Sales AI', icon: 'ai' },
  { to: '/sales-push', label: 'Sales Push', icon: 'ai', adminOnly: true },
  { to: '/forms', label: 'Forms', icon: 'forms' },
  { to: '/documents', label: 'Documents', icon: 'documents' },
  {
    label: 'Settings',
    icon: 'settings',
    roles: ['admin'],
    submenu: [
      { to: '/email', label: 'Email Settings' },
      { to: '/users', label: 'Users' },
      { to: '/integration', label: 'Integration' },
      { to: '/backups', label: 'Backups' },
      { to: '/monitoring', label: 'Monitoring' }
    ]
  }
];

export default function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [expandedSubmenu, setExpandedSubmenu] = useState(null);

  // `roles` restricts a nav item to an exact allow-list (Settings/Integration/Team
  // are admin-only). `adminOnly` is the looser admin-or-manager rule. `repHidden`
  // just hides an item from the rep role, leaving it open to everyone else.
  const nav = NAV.filter((n) => {
    if (n.roles) return n.roles.includes(user.role);
    if (n.adminOnly && !['admin', 'manager'].includes(user.role)) return false;
    if (n.repHidden && user.role === 'rep') return false;
    return true;
  });

  // Auto-expand submenu if current path matches a submenu item. Checks the
  // stable module-level NAV (not the per-render-filtered `nav`) so this only
  // re-runs on an actual navigation, not on every render - otherwise it fights
  // the collapse button, since `nav` is a new array reference each render.
  useEffect(() => {
    const currentSubmenuParent = NAV.find(n =>
      n.submenu?.some(s => s.to === location.pathname)
    );
    if (currentSubmenuParent) {
      setExpandedSubmenu(currentSubmenuParent.label);
    }
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-60 transform flex-col bg-navy-900 text-slate-300 transition-transform lg:static lg:translate-x-0 ${menuOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex items-center gap-2.5 px-5 py-5">
          <img src="/icon-light.svg" alt="" className="h-9 w-9" />
          <div>
            <div className="text-lg font-extrabold leading-none tracking-tight text-white">Route<span className="text-brand-500">One</span></div>
            <div className="mt-1 text-[10px] uppercase tracking-widest text-slate-400">Field Sales</div>
          </div>
        </div>
        <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pb-6">
          {nav.map((n) => {
            if (n.submenu) {
              const isExpanded = expandedSubmenu === n.label;
              return (
                <div key={n.label}>
                  <button
                    onClick={() => setExpandedSubmenu(isExpanded ? null : n.label)}
                    className="w-full flex items-center gap-3 rounded-lg px-2.5 py-1.5 text-sm font-medium hover:bg-navy-800 hover:text-white text-slate-300"
                  >
                    <AppIcon name={n.icon} size={28} />
                    <span className="flex-1 text-left">{n.label}</span>
                    <span className={`text-xs transition-transform ${isExpanded ? 'rotate-180' : ''}`}>▼</span>
                  </button>
                  {isExpanded && (
                    <div className="space-y-0.5 ml-6 mt-1">
                      {n.submenu.map((sub) => (
                        <NavLink
                          key={sub.to}
                          to={sub.to}
                          onClick={() => setMenuOpen(false)}
                          className={({ isActive }) =>
                            `block rounded-lg px-2.5 py-1.5 text-sm font-medium ${isActive ? 'bg-brand-600 text-white' : 'text-slate-400 hover:bg-navy-800 hover:text-white'}`
                          }
                        >
                          {sub.label}
                        </NavLink>
                      ))}
                    </div>
                  )}
                </div>
              );
            }
            return (
              <NavLink
                key={n.to} to={n.to} end={n.end}
                onClick={() => setMenuOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-lg px-2.5 py-1.5 text-sm font-medium ${isActive ? 'bg-brand-600 text-white' : 'hover:bg-navy-800 hover:text-white'}`}
              >
                <AppIcon name={n.icon} size={28} />{n.label}
              </NavLink>
            );
          })}
        </nav>
        {/* Sign-out section: always visible at the bottom, never scrolls away */}
        <div className="shrink-0 flex items-start gap-3 border-t border-slate-800 px-5 py-4">
          <AppIcon name="account" size={28} />
          <div>
            <div className="text-sm font-medium text-white">{user.name}</div>
            <div className="text-xs text-slate-500 capitalize">{user.role}</div>
            <button onClick={logout} className="mt-2 text-xs text-slate-400 hover:text-white">Sign out →</button>
          </div>
        </div>
      </aside>
      {menuOpen && <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => setMenuOpen(false)} />}

      {/* Main */}
      <div className="flex-1 min-w-0">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
          <button className="lg:hidden btn-secondary px-2.5" onClick={() => setMenuOpen(true)}>☰</button>
          <div className="hidden lg:flex items-center gap-3 text-sm text-slate-400">
            <img src="/bakels-logo.png" alt="Bakels" className="h-5" />
            <span>RouteOne — Field Sales Platform</span>
          </div>
          <NavLink to="/mobile" className="btn-secondary text-xs">📱 Rep app</NavLink>
        </header>
        <main className="p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
