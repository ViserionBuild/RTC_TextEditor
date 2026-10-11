import type { Presence } from '@collabpad/protocol';
import type { Identity } from '../collab/plugin';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

export function Avatars({ me, peers }: { me: Identity; peers: Presence[] }) {
  const shown = peers.slice(0, 5);
  return (
    <div className="avatars" aria-label={`${peers.length + 1} people editing`}>
      {shown.map((p, i) => (
        <span key={i} className="avatar" style={{ background: p.color }} title={p.name}>
          {initials(p.name)}
        </span>
      ))}
      {peers.length > shown.length && (
        <span className="avatar more">+{peers.length - shown.length}</span>
      )}
      <span className="avatar me" style={{ background: me.color }} title={`${me.name} (you)`}>
        {initials(me.name)}
      </span>
    </div>
  );
}
