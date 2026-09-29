import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { Spinner } from './components/ui';
import Login from './pages/Login';
import ChooseApp from './pages/ChooseApp';
import ChangePassword from './pages/ChangePassword';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';

// React Router doesn't reset scroll position on navigation - without this,
// clicking into a long list's detail page (e.g. an order or quote) leaves the
// new page scrolled to wherever the list happened to be.
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return null;
}

// Lazy-loaded so each role only downloads the code it actually uses: a rep's
// phone never pulls in the back-office pages or the Leaflet maps, and those
// maps only load when a map page is opened.
const Layout = lazy(() => import('./components/Layout'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Customers = lazy(() => import('./pages/Customers'));
const CustomerDetail = lazy(() => import('./pages/CustomerDetail'));
const Products = lazy(() => import('./pages/Products'));
const Orders = lazy(() => import('./pages/Orders'));
const OrderDetail = lazy(() => import('./pages/OrderDetail'));
const Quotes = lazy(() => import('./pages/Quotes'));
const QuoteDetail = lazy(() => import('./pages/QuoteDetail'));
const FormsAdmin = lazy(() => import('./pages/FormsAdmin'));
const Documents = lazy(() => import('./pages/Documents'));
const EmailSettings = lazy(() => import('./pages/EmailSettings'));
const SalesPush = lazy(() => import('./pages/SalesPush'));
const Monitoring = lazy(() => import('./pages/Monitoring'));
const Visits = lazy(() => import('./pages/Visits'));
const RoutesPage = lazy(() => import('./pages/Routes'));
const LiveMap = lazy(() => import('./pages/LiveMap'));
const Kpis = lazy(() => import('./pages/Kpis'));
const Integration = lazy(() => import('./pages/Integration'));
const Backups = lazy(() => import('./pages/Backups'));
const Analytics = lazy(() => import('./pages/Analytics'));
const SalesAI = lazy(() => import('./pages/SalesAI'));
const Users = lazy(() => import('./pages/Users'));
const Team = lazy(() => import('./pages/Team'));
const RepDetail = lazy(() => import('./pages/RepDetail'));
const Tasks = lazy(() => import('./pages/Tasks'));
const SupportTickets = lazy(() => import('./pages/SupportTickets'));
const Invoices = lazy(() => import('./pages/Invoices'));
const InvoiceDetail = lazy(() => import('./pages/InvoiceDetail'));
const MobileApp = lazy(() => import('./mobile/MobileApp'));

export default function App() {
  const { user } = useAuth();
  if (user === undefined) return <Spinner />;
  if (!user)
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  if (user.must_change_password) return <ChangePassword />;

  // Reps get both the mobile app and a scoped back-office main menu (they
  // choose which one right after login, on the /choose screen). Office roles
  // only ever see the back office, plus can jump into /mobile to preview it.
  const isRep = user.role === 'rep';

  return (
    <Suspense fallback={<Spinner />}>
      <ScrollToTop />
      <Routes>
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/choose" element={isRep ? <ChooseApp /> : <Navigate to="/" replace />} />
        <Route path="/mobile/*" element={<MobileApp />} />
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/customers/:id" element={<CustomerDetail />} />
          <Route path="/products" element={<Products />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/orders/:id" element={<OrderDetail />} />
          <Route path="/invoices" element={<Invoices />} />
          <Route path="/invoices/:id" element={<InvoiceDetail />} />
          <Route path="/quotes" element={<Quotes />} />
          <Route path="/quotes/:id" element={<QuoteDetail />} />
          <Route path="/forms" element={<FormsAdmin />} />
          <Route path="/documents" element={<Documents />} />
          <Route path="/visits" element={<Visits />} />
          <Route path="/routes" element={<RoutesPage />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/support" element={<SupportTickets />} />
          <Route path="/kpis" element={<Kpis />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/ai" element={<SalesAI />} />
          {/* Team roster + Live map show every rep's data, not just "their
              account" — manager/office/admin only, per user decision. */}
          {!isRep && <Route path="/map" element={<LiveMap />} />}
          {!isRep && <Route path="/team" element={<Team />} />}
          {!isRep && <Route path="/team/:id" element={<RepDetail />} />}
          {!isRep && <Route path="/email" element={<EmailSettings />} />}
          {['admin', 'manager'].includes(user.role) && <Route path="/sales-push" element={<SalesPush />} />}
          {!isRep && <Route path="/integration" element={<Integration />} />}
          {!isRep && <Route path="/backups" element={<Backups />} />}
          {!isRep && <Route path="/monitoring" element={<Monitoring />} />}
          {!isRep && <Route path="/users" element={<Users />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
