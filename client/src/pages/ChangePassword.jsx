import { useState } from 'react';
import { useAuth } from '../auth';
import { ErrorNote } from '../components/ui';

export default function ChangePassword() {
  const { changePassword, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="card w-full max-w-md space-y-4 p-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Choose a new password</h1>
          <p className="mt-1 text-sm text-slate-500">Use at least 12 characters. This is required before continuing.</p>
        </div>
        <ErrorNote error={error} />
        <div>
          <label className="label">Current password</label>
          <input className="input" type="password" autoComplete="current-password"
            value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required autoFocus />
        </div>
        <div>
          <label className="label">New password</label>
          <input className="input" type="password" minLength={9} maxLength={128} autoComplete="new-password"
            value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
        </div>
        <div>
          <label className="label">Confirm new password</label>
          <input className="input" type="password" minLength={9} maxLength={128} autoComplete="new-password"
            value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
        </div>
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? 'Updating...' : 'Update password'}
        </button>
        <button className="w-full text-sm text-slate-500 hover:text-slate-700" type="button" onClick={logout}>
          Sign out
        </button>
      </form>
    </div>
  );
}
