import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { ErrorNote } from '../components/ui';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const navigate = useNavigate();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await api.post('/auth/reset-password', { token, new_password: newPassword });
      setDone(true);
      setTimeout(() => navigate('/login', { replace: true }), 2000);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <img src="/logo.svg" alt="RouteOne" className="mx-auto h-20" />
          <p className="mt-2 text-sm text-slate-500">Bakels Field sales platform</p>
        </div>

        <div className="card p-6 space-y-4">
          {!token ? (
            <>
              <h1 className="text-lg font-bold">Invalid reset link</h1>
              <p className="text-sm text-slate-500">This link is missing its reset token.</p>
              <Link to="/forgot-password" className="btn-primary block w-full text-center">Request a new link</Link>
            </>
          ) : done ? (
            <>
              <h1 className="text-lg font-bold">Password updated</h1>
              <p className="text-sm text-slate-500">Redirecting you to sign in…</p>
            </>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <h1 className="text-lg font-bold">Choose a new password</h1>
              <p className="text-sm text-slate-500">Use at least 9 characters.</p>
              <ErrorNote error={error} />
              <div>
                <label className="label">New password</label>
                <input className="input" type="password" minLength={9} maxLength={128} autoComplete="new-password"
                  value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required autoFocus />
              </div>
              <div>
                <label className="label">Confirm new password</label>
                <input className="input" type="password" minLength={9} maxLength={128} autoComplete="new-password"
                  value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
              </div>
              <button className="btn-primary w-full" disabled={busy}>{busy ? 'Updating…' : 'Update password'}</button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
