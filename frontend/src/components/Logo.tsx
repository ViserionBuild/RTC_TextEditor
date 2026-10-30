import { navigate } from '../lib/router';

export function Logo() {
  return (
    <a
      href="/"
      className="logo"
      onClick={(e) => {
        e.preventDefault();
        navigate('/');
      }}
    >
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <rect x="4" y="2" width="16" height="20" rx="2.5" fill="var(--accent)" />
        <path d="M8 8h8M8 12h8M8 16h5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      <span className="hide-md">CollabPad</span>
    </a>
  );
}
