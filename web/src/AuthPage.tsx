import { useState } from 'react';
import { api } from './api';
import { Logo } from './ui';

export default function AuthPage({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('signup');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'signup') {
        const { needsConfirmation } = await api.signup(name, email, password);
        if (needsConfirmation) {
          setConfirmEmail(true);
          return;
        }
      } else {
        await api.login(email, password);
      }
      onAuthed();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (confirmEmail) {
    return (
      <div className="auth">
        <div className="auth-card">
          <div className="auth-logo">
            <Logo size={40} />
            <h1>Check your email</h1>
          </div>
          <p>
            We sent a confirmation link to <strong>{email}</strong>. Open it, then come back and log in.
          </p>
          <button
            className="btn primary"
            onClick={() => {
              setConfirmEmail(false);
              setMode('login');
              setPassword('');
            }}
          >
            Go to log in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-logo">
          <Logo size={40} />
          <h1>Herdr</h1>
        </div>
        <p className="tagline">Project management that herds the cats for you.</p>
        {mode === 'signup' && (
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
          </label>
        )}
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={mode === 'login'} />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={mode === 'signup' ? 8 : undefined}
            required
          />
        </label>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="btn primary" disabled={busy}>
          {mode === 'signup' ? 'Create account' : 'Log in'}
        </button>
        <button type="button" className="link" onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setError(''); }}>
          {mode === 'signup' ? 'Already have an account? Log in' : 'New here? Create an account'}
        </button>
      </form>
    </div>
  );
}
