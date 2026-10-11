import { Suspense, lazy } from 'react';
import { Home } from './pages/Home';
import { usePath } from './lib/router';

// The editor (CodeMirror + CRDT) is only needed on document pages.
const DocPage = lazy(() => import('./pages/DocPage').then((m) => ({ default: m.DocPage })));

export function App() {
  const path = usePath();
  const match = /^\/d\/([A-Za-z0-9_-]+)\/?$/.exec(path);
  if (!match) return <Home />;
  return (
    <Suspense fallback={null}>
      <DocPage key={match[1]} docId={match[1]!} />
    </Suspense>
  );
}
