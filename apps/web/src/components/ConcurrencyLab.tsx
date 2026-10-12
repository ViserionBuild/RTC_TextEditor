import { Doc, type Op } from '@collabpad/crdt';
import { useState } from 'react';

interface Step {
  label: string;
  texts: [string, string][];
}

interface Scenario {
  id: string;
  title: string;
  run(): Step[];
}

const snapshot = (docs: Doc[]): [string, string][] => docs.map((d) => [d.replica, d.text()]);
const syncAll = (docs: Doc[]) => {
  for (const a of docs)
    for (const b of docs) if (a !== b) b.applyRemote(a.opsSince(b.versionVector()));
};

/** The two concurrency cases from the PRD, replayed on in-memory replicas. */
const SCENARIOS: Scenario[] = [
  {
    id: 'qa5',
    title: 'Three people type at the same spot',
    run() {
      const docs = ['alice', 'bob', 'carol'].map((r) => new Doc(r));
      const [a, b, c] = docs as [Doc, Doc, Doc];
      const steps: Step[] = [];
      a.insertAt(0, 'Hello!');
      syncAll(docs);
      steps.push({ label: 'Everyone has "Hello!"', texts: snapshot(docs) });
      a.insertAt(5, ' Alice');
      b.insertAt(5, ' Bob');
      c.insertAt(5, ' Carol');
      steps.push({ label: 'Offline, each types at index 5', texts: snapshot(docs) });
      // Deliver in a different order to each replica.
      const ops = (d: Doc): Op[] => d.opsSince({}).filter((op) => op.id.replica === d.replica);
      a.applyRemote([...ops(c), ...ops(b)]);
      b.applyRemote([...ops(a), ...ops(c)]);
      c.applyRemote([...ops(b), ...ops(a)]);
      steps.push({ label: 'Reconnect (different delivery orders)', texts: snapshot(docs) });
      return steps;
    },
  },
  {
    id: 'qa6',
    title: 'Insert next to a character someone deletes',
    run() {
      const docs = ['alice', 'bob'].map((r) => new Doc(r));
      const [a, b] = docs as [Doc, Doc];
      const steps: Step[] = [];
      a.insertAt(0, 'cat');
      syncAll(docs);
      steps.push({ label: 'Both have "cat"', texts: snapshot(docs) });
      a.deleteRange(1, 1);
      b.insertAt(2, 'r');
      steps.push({ label: 'Alice deletes "a"; Bob types "r" after it', texts: snapshot(docs) });
      syncAll(docs);
      steps.push({
        label: 'Merge: Bob’s "r" survives next to the tombstone',
        texts: snapshot(docs),
      });
      return steps;
    },
  },
];

export function ConcurrencyLab() {
  const [result, setResult] = useState<{ id: string; steps: Step[] } | null>(null);
  const last = result?.steps.at(-1);
  const converged = last ? new Set(last.texts.map(([, t]) => t)).size === 1 : false;

  return (
    <section className="lab">
      <div className="lab-buttons">
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            className="ghost"
            aria-pressed={result?.id === s.id}
            onClick={() => setResult({ id: s.id, steps: s.run() })}
          >
            {s.title}
          </button>
        ))}
      </div>
      {result && (
        <ol className="lab-steps">
          {result.steps.map((step, i) => (
            <li key={i}>
              <div className="lab-label">{step.label}</div>
              {step.texts.map(([replica, text]) => (
                <div key={replica} className="lab-row">
                  <span className="muted">{replica}</span>
                  <code>{JSON.stringify(text)}</code>
                </div>
              ))}
            </li>
          ))}
          <li className={converged ? 'lab-ok' : 'lab-bad'}>
            {converged ? '✓ All replicas converged' : '✗ Replicas differ'}
          </li>
        </ol>
      )}
    </section>
  );
}
