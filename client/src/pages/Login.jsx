import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { ErrorNote } from '../components/ui';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const user = await login(email, password);
      navigate(user.role === 'rep' ? '/choose' : '/', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* RouteOne logo at top */}
        <div className="mb-8 text-center">
          <img src="/logo.svg" alt="RouteOne" className="mx-auto h-20" />
          <p className="mt-2 text-sm text-slate-500">Bakels Field sales platform</p>
          <img src="/bakels-logo.png" alt="Bakels" className="mx-auto mt-2 h-8" />
        </div>

        {/* Login form */}
        <form onSubmit={submit} className="card p-6 space-y-4">
          <ErrorNote error={error} />
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          <div>
            <label className="label">Password</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <button className="btn-primary w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <Link to="/forgot-password" className="block text-center text-sm text-slate-500 hover:underline">Forgot your password?</Link>
        </form>
      </div>
    </div>
  );
}
