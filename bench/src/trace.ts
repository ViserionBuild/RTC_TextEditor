import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

/** Sequential editing trace: each patch is [position, deleteCount, insertText]. */
export interface Trace {
  startContent: string;
  endContent: string;
  patches: [number, number, string][];
}

/** Parse the trace as plain JSON data (never executed). */
export function loadTrace(path: string): Trace {
  const raw = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as {
    startContent: string;
    endContent: string;
    txns: { patches: [number, number, string][] }[];
  };
  return {
    startContent: raw.startContent,
    endContent: raw.endContent,
    patches: raw.txns.flatMap((t) => t.patches),
  };
}
