import type { Status, SyncClient } from '@collabpad/client';
import type { Presence } from '@collabpad/protocol';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { openSession } from '../collab/session';
import { Avatars } from '../components/Avatars';
import { DebugPanel } from '../components/DebugPanel';
import { Editor } from '../components/Editor';
import { Logo } from '../components/Logo';
import { StatusBadge } from '../components/StatusBadge';
import { TitleInput } from '../components/TitleInput';
import { NotFoundError, getDoc, renameDoc } from '../lib/api';
import { loadIdentity } from '../lib/identity';
import { listRecent, touchRecent } from '../lib/recent';

type Load = { state: 'loading' } | { state: 'missing' } | { state: 'ready'; client: SyncClient };

export function DocPage({ docId }: { docId: string }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [title, setTitle] = useState(
    () => listRecent().find((d) => d.id === docId)?.title ?? 'Untitled',
  );
  const [peers, setPeers] = useState<Presence[]>([]);
  const [debug, setDebug] = useState(() => new URLSearchParams(location.search).has('debug'));
  const [copied, setCopied] = useState(false);
  const [identity] = useState(loadIdentity);

  useEffect(() => {
    let cancelled = false;
    let close: (() => Promise<void>) | undefined;

    void (async () => {
      try {
        const meta = await getDoc(docId);
        if (cancelled) return;
        setTitle(meta.title);
        touchRecent(docId, meta.title);
      } catch (err) {
        // Offline is fine (we work from IndexedDB); a definite 404 is not.
        if (err instanceof NotFoundError) return !cancelled && setLoad({ state: 'missing' });
      }
      const session = await openSession(docId);
      if (cancelled) return void session.close();
      close = session.close;
      session.onReplace((client) => setLoad({ state: 'ready', client }));
      setLoad({ state: 'ready', client: session.client });
    })();

    return () => {
      cancelled = true;
      void close?.();
    };
  }, [docId]);

  // Read live from whichever client is current (it is replaced after a rejoin).
  const client = load.state === 'ready' ? load.client : null;
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!client) return () => {};
      const off = [client.on('status', onChange), client.on('pending', onChange)];
      return () => off.forEach((fn) => fn());
    },
    [client],
  );
  const status: Status = useSyncExternalStore(subscribe, () => client?.status ?? 'connecting');
  const pending = useSyncExternalStore(subscribe, () => client?.pending ?? 0);

  useEffect(() => {
    if (!client) return;
    const off = [
      client.on('presence', () => setPeers([...client.peerPresence.values()])),
      client.on('fatal', () => setLoad({ state: 'missing' })),
    ];
    return () => off.forEach((fn) => fn());
  }, [client]);

  useEffect(() => {
    document.title = `${title} · CollabPad`;
  }, [title]);

  const commitTitle = (next: string) => {
    setTitle(next);
    touchRecent(docId, next);
    renameDoc(docId, next).catch(() => {});
  };

  const share = async () => {
    await navigator.clipboard?.writeText(location.href.replace(/\?.*$/, ''));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (load.state === 'missing') {
    return (
      <div className="center-message">
        <Logo />
        <h1>Document not found</h1>
        <p className="muted">
          The link may be wrong, or the document was created on another server.
        </p>
      </div>
    );
  }

  return (
    <div className={`docpage${debug ? ' with-debug' : ''}`}>
      <header className="topbar">
        <Logo />
        <TitleInput value={title} onCommit={commitTitle} />
        <StatusBadge status={status} pending={pending} />
        <div className="spacer" />
        <Avatars me={identity} peers={peers} />
        <button className="ghost" onClick={() => setDebug((d) => !d)} aria-pressed={debug}>
          {'</>'}
          <span className="hide-md"> Internals</span>
        </button>
        <button className="primary" onClick={() => void share()}>
          {copied ? 'Link copied' : 'Share'}
        </button>
      </header>
      <div className="workspace">
        <main className="sheet-wrap">
          <div className="sheet">
            {load.state === 'ready' ? (
              <Editor client={load.client} identity={identity} />
            ) : (
              <p className="muted">Loading…</p>
            )}
          </div>
        </main>
        {debug && load.state === 'ready' && (
          <DebugPanel client={load.client} onClose={() => setDebug(false)} />
        )}
      </div>
    </div>
  );
}
