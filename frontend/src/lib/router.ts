import { useSyncExternalStore } from 'react';

/** Two routes do not justify a router dependency. */
const subscribe = (cb: () => void) => {
  window.addEventListener('popstate', cb);
  return () => window.removeEventListener('popstate', cb);
};

export const usePath = (): string => useSyncExternalStore(subscribe, () => location.pathname);

export function navigate(path: string): void {
  history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
