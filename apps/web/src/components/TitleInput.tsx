import { useState } from 'react';

export function TitleInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (title: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // Adopt a new title from the server without an effect (React's "adjust state on prop change").
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
  }

  const commit = () => {
    const next = draft.trim() || 'Untitled';
    setDraft(next);
    if (next !== value) onCommit(next);
  };

  return (
    <input
      className="title"
      value={draft}
      aria-label="Document title"
      maxLength={200}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
