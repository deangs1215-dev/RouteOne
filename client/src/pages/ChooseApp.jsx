// Shown once, right after a field rep logs in: pick the mobile app (for use
// out in the field) or the full back-office main menu (scoped to their own
// account — same pages internal sales sees, but only their own customers,
// orders, quotes etc).
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';

export default function ChooseApp() {
  const { user } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm text-center">
        <img src="/logo.svg" alt="RouteOne" className="mx-auto h-16" />
        <h1 className="mt-4 text-lg font-bold text-navy-900">Welcome, {user?.name?.split(' ')[0]}</h1>
        <p className="mt-1 text-sm text-slate-500">How would you like to work today?</p>

        <div className="mt-6 space-y-3">
          <button
            className="w-full rounded-xl border-2 border-brand-600 bg-brand-600 px-5 py-4 text-left text-white shadow-sm transition hover:bg-brand-700"
            onClick={() => navigate('/mobile', { replace: true })}
          >
            <div className="text-base font-bold">📱 Mobile App</div>
            <div className="mt-0.5 text-xs text-brand-100">Check in on visits, capture orders, manage tasks in the field</div>
          </button>

          <button
            className="w-full rounded-xl border-2 border-slate-200 bg-white px-5 py-4 text-left shadow-sm transition hover:border-brand-300 hover:bg-slate-50"
            onClick={() => navigate('/', { replace: true })}
          >
            <div className="text-base font-bold text-navy-900">🖥️ Main Menu</div>
            <div className="mt-0.5 text-xs text-slate-500">Full back-office view of your own customers, orders and reports</div>
          </button>
        </div>
      </div>
    </div>
  );
}
