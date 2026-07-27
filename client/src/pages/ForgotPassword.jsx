import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ErrorNote } from '../components/ui';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/forgot-password', { email });
      setSent(true);
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
          {sent ? (
            <>
              <h1 className="text-lg font-bold">Check your email</h1>
              <p className="text-sm text-slate-500">
                If that email address is on file, we've sent a link to reset your password.
                It expires in 1 hour.
              </p>
              <Link to="/login" className="btn-primary block w-full text-center">Back to sign in</Link>
            </>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <h1 className="text-lg font-bold">Forgot your password?</h1>
              <p className="text-sm text-slate-500">Enter your email and we'll send you a reset link.</p>
              <ErrorNote error={error} />
              <div>
                <label className="label">Email</label>
                <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
              </div>
              <button className="btn-primary w-full" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
              <Link to="/login" className="block text-center text-sm text-slate-500 hover:underline">Back to sign in</Link>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
