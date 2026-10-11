import { useState } from 'react';
import { Logo } from '../components/Logo';
import { createDoc } from '../lib/api';
import { listRecent, relativeTime } from '../lib/recent';
import { navigate } from '../lib/router';

export function Home() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recent = listRecent();

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const doc = await createDoc();
      navigate(`/d/${doc.id}`);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      setBusy(false);
    }
  };

  return (
    <div className="home">
      <header className="topbar">
        <Logo />
      </header>
      <main className="home-main">
        <section className="hero">
          <h1>Write together, even offline.</h1>
          <p>
            A shared notepad. Open a document, send the link, and everyone types at once. Edits made
            offline merge automatically when you reconnect.
          </p>
          <button className="primary" onClick={() => void create()} disabled={busy}>
            {busy ? 'Creating…' : '+ New document'}
          </button>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>

        <section className="recent">
          <h2>Recent documents</h2>
          {recent.length === 0 ? (
            <p className="muted">Documents you open on this device show up here.</p>
          ) : (
            <ul>
              {recent.map((d) => (
                <li key={d.id}>
                  <a
                    href={`/d/${d.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`/d/${d.id}`);
                    }}
                  >
                    <span className="recent-title">{d.title}</span>
                    <span className="muted">{relativeTime(d.openedAt)}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
