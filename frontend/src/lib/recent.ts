const KEY = 'collabpad:recent';
const MAX = 20;

export interface RecentDoc {
  id: string;
  title: string;
  openedAt: number;
}

export function listRecent(): RecentDoc[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]') as RecentDoc[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function touchRecent(id: string, title: string): void {
  const next = [{ id, title, openedAt: Date.now() }, ...listRecent().filter((d) => d.id !== id)];
  try {
    localStorage.setItem(KEY, JSON.stringify(next.slice(0, MAX)));
  } catch {
    // storage unavailable
  }
}

export function relativeTime(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}
