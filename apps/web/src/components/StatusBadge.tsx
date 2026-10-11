import type { Status } from '@collabpad/client';

export function StatusBadge({ status, pending }: { status: Status; pending: number }) {
  const label =
    status === 'online'
      ? pending > 0
        ? 'Saving…'
        : 'All changes saved'
      : status === 'connecting'
        ? 'Connecting…'
        : pending > 0
          ? `Offline · ${pending} change${pending === 1 ? '' : 's'} pending`
          : 'Offline';
  return (
    <span className={`status status-${status}`} role="status" aria-live="polite">
      <span className="status-dot" />
      {/* On phones the calm "saved" state is just the green dot; problems keep their text. */}
      <span className={status === 'online' && pending === 0 ? 'hide-sm' : undefined}>{label}</span>
    </span>
  );
}
