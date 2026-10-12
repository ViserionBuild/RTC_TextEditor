import type { SyncClient } from '@collabpad/client';
import type { Op, VersionVector } from '@collabpad/crdt';
import { useEffect, useState } from 'react';
import { ConcurrencyLab } from './ConcurrencyLab';

interface LogLine {
  dir: 'local' | 'remote';
  text: string;
}

const describe = (op: Op) =>
  op.type === 'ins'
    ? `ins ${JSON.stringify(op.char)} ${op.id.seq}@${op.id.replica} after ${op.origin ? `${op.origin.seq}@${op.origin.replica}` : 'HEAD'}`
    : `del ${op.target.seq}@${op.target.replica} (op ${op.id.seq}@${op.id.replica})`;

const formatBytes = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

/** Shows the machinery: version vectors, tombstones, bytes on the wire and the op stream. */
export function DebugPanel({ client, onClose }: { client: SyncClient; onClose: () => void }) {
  const [, setTick] = useState(0);
  const [log, setLog] = useState<LogLine[]>([]);
  const [stable, setStable] = useState<VersionVector>({});

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 500);
    const push = (dir: LogLine['dir']) => (ops: Op[]) =>
      setLog((prev) =>
        [...ops.map((op) => ({ dir, text: describe(op) })).reverse(), ...prev].slice(0, 200),
      );
    const off = [
      client.on('local', push('local')),
      client.on('remote', push('remote')),
      client.on('stable', setStable),
    ];
    return () => {
      clearInterval(t);
      off.forEach((fn) => fn());
    };
  }, [client]);

  const doc = client.doc;
  const stats = doc.stats();
  const local = doc.versionVector();
  const server = client.serverVersionVector;
  const replicas = [...new Set([...Object.keys(local), ...Object.keys(server)])].sort();
  const offline = client.status === 'offline';

  return (
    <aside className="debug" aria-label="Sync internals">
      <header>
        <h2>Sync internals</h2>
        <button className="ghost" onClick={onClose} aria-label="Close debug panel">
          ✕
        </button>
      </header>

      <label className="toggle">
        <input
          type="checkbox"
          checked={offline}
          onChange={(e) => (e.target.checked ? client.disconnect() : client.connect())}
        />
        Simulate offline
      </label>

      <dl className="kv">
        <dt>Replica</dt>
        <dd>
          <code>{doc.replica}</code>
        </dd>
        <dt>State hash</dt>
        <dd>
          <code>{doc.stateHash().slice(0, 16)}</code>
        </dd>
        <dt>Visible chars</dt>
        <dd>{stats.visible}</dd>
        <dt>Tombstones</dt>
        <dd>
          {stats.tombstones}
          {stats.elements > 0 && ` (${Math.round((100 * stats.tombstones) / stats.elements)}%)`}
        </dd>
        <dt>Ops in log</dt>
        <dd>{stats.ops}</dd>
        <dt>Unacked / buffered</dt>
        <dd>
          {client.pending} / {doc.pendingCount}
        </dd>
        <dt>Bytes sent / recv</dt>
        <dd>
          {formatBytes(client.bytes.sent)} / {formatBytes(client.bytes.received)}
        </dd>
      </dl>

      <h3>Version vectors</h3>
      <table className="vv">
        <thead>
          <tr>
            <th>replica</th>
            <th>local</th>
            <th>relay</th>
            <th>stable</th>
          </tr>
        </thead>
        <tbody>
          {replicas.map((r) => (
            <tr key={r} className={r === doc.replica ? 'self' : undefined}>
              <td>
                <code>{r}</code>
              </td>
              <td>{local[r] ?? 0}</td>
              <td>{server[r] ?? 0}</td>
              <td>{stable[r] ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Concurrency lab</h3>
      <ConcurrencyLab />

      <h3>Op stream</h3>
      <ol className="oplog">
        {log.map((l, i) => (
          <li key={log.length - i} className={l.dir}>
            <span>{l.dir === 'local' ? '↑' : '↓'}</span> <code>{l.text}</code>
          </li>
        ))}
        {log.length === 0 && <li className="empty">Type something, or edit from another tab.</li>}
      </ol>
    </aside>
  );
}
