export interface DocMeta {
  id: string;
  title: string;
  createdAt: number;
}

/** Relay origin. Empty = same origin (Vite proxies /api and /ws to the relay in dev). */
const RELAY = (import.meta.env.VITE_RELAY_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export function wsUrl(): string {
  if (RELAY) return `${RELAY.replace(/^http/, 'ws')}/ws`;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

export class NotFoundError extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${RELAY}${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (res.status === 404) throw new NotFoundError(path);
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

export const createDoc = (title?: string) =>
  call<DocMeta>('/api/docs', { method: 'POST', body: JSON.stringify(title ? { title } : {}) });

export const getDoc = (id: string) => call<DocMeta>(`/api/docs/${encodeURIComponent(id)}`);

export const renameDoc = (id: string, title: string) =>
  call<DocMeta>(`/api/docs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
