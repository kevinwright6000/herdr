import type { Priority, Task } from './types';

export const PRIORITIES: Priority[] = ['none', 'low', 'medium', 'high', 'urgent'];
export const PRIORITY_RANK: Record<Priority, number> = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 };

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

const AVATAR_COLORS = ['#0f766e', '#2563eb', '#7c3aed', '#c2410c', '#be185d', '#4d7c0f', '#0369a1'];
export const avatarColor = (id: string) => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
};

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const formatDue = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export const timeAgo = (iso: string) => {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const GAP = 1024;
/** Mirror of the server's fractional ordering so drags feel instant before the response lands. */
export function positionFor(siblings: Task[], index: number): number {
  const i = Math.max(0, Math.min(index, siblings.length));
  const before = siblings[i - 1]?.position;
  const after = siblings[i]?.position;
  if (before === undefined && after === undefined) return GAP;
  if (before === undefined) return after! / 2;
  if (after === undefined) return before + GAP;
  return (before + after) / 2;
}
