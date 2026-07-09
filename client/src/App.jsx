import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './auth';
import { Spinner } from './components/ui';
import Login from './pages/Login';

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
const Visits = lazy(() => import('./pages/Visits'));
const RoutesPage = lazy(() => import('./pages/Routes'));
const LiveMap = lazy(() => import('./pages/LiveMap'));
const Kpis = lazy(() => import('./pages/Kpis'));
const Integration = lazy(() => import('./pages/Integration'));
const Analytics = lazy(() => import('./pages/Analytics'));
const SalesAI = lazy(() => import('./pages/SalesAI'));
const Users = lazy(() => import('./pages/Users'));
const Team = lazy(() => import('./pages/Team'));
const RepDetail = lazy(() => import('./pages/RepDetail'));
const Tasks = lazy(() => import('./pages/Tasks'));
const MobileApp = lazy(() => import('./mobile/MobileApp'));

export default function App() {
  const { user } = useAuth();
  if (user === undefined) return <Spinner />;
  if (!user)
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );

  // Reps land in the mobile app; office roles get the back office.
  return (
    <Suspense fallback={<Spinner />}>
      {user.role === 'rep' ? (
        <Routes>
          <Route path="/mobile/*" element={<MobileApp />} />
          <Route path="*" element={<Navigate to="/mobile" replace />} />
        </Routes>
      ) : (
        <Routes>
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/mobile/*" element={<MobileApp />} />
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/customers" element={<Customers />} />
            <Route path="/customers/:id" element={<CustomerDetail />} />
            <Route path="/products" element={<Products />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/orders/:id" element={<OrderDetail />} />
            <Route path="/quotes" element={<Quotes />} />
            <Route path="/quotes/:id" element={<QuoteDetail />} />
            <Route path="/forms" element={<FormsAdmin />} />
            <Route path="/visits" element={<Visits />} />
            <Route path="/routes" element={<RoutesPage />} />
            <Route path="/map" element={<LiveMap />} />
            <Route path="/team" element={<Team />} />
            <Route path="/team/:id" element={<RepDetail />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/kpis" element={<Kpis />} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/ai" element={<SalesAI />} />
            <Route path="/integration" element={<Integration />} />
            <Route path="/users" element={<Users />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      )}
    </Suspense>
  );
}
