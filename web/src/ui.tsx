import type { Label, Priority, User } from './types';
import { avatarColor, initials } from './lib';

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--brand)" />
      <rect x="6" y="8" width="5" height="16" rx="2" fill="#fff" />
      <rect x="13.5" y="8" width="5" height="10" rx="2" fill="#fff" />
      <rect x="21" y="8" width="5" height="13" rx="2" fill="#fff" />
    </svg>
  );
}

export function Avatar({ user, size = 24 }: { user: Pick<User, 'id' | 'name'>; size?: number }) {
  return (
    <span
      className="avatar"
      title={user.name}
      style={{ width: size, height: size, fontSize: size * 0.42, background: avatarColor(user.id) }}
    >
      {initials(user.name)}
    </span>
  );
}

export function LabelChip({ label }: { label: Label }) {
  return (
    <span className="chip" style={{ ['--chip' as string]: label.color }}>
      {label.name}
    </span>
  );
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  if (priority === 'none') return null;
  return <span className={`priority p-${priority}`}>{priority}</span>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
