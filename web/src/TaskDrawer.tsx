import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { PRIORITIES, timeAgo } from './lib';
import type { Board, Priority, Task, TaskDetail, User } from './types';
import { Avatar } from './ui';

export default function TaskDrawer({
  taskId, board, me, onClose, run,
}: {
  taskId: string;
  board: Board;
  me: User;
  onClose: () => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [comment, setComment] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [labelName, setLabelName] = useState('');

  const task = board.tasks.find((t) => t.id === taskId);
  const userName = (id: string | null) => board.members.find((m) => m.id === id)?.name ?? 'Someone';

  const load = useCallback(async () => {
    try {
      setDetail(await api.task(taskId));
    } catch {
      onClose(); // deleted by a teammate
    }
  }, [taskId, onClose]);

  // Reload comments/activity whenever the board refreshes (live updates).
  useEffect(() => {
    void load();
  }, [load, task?.updatedAt, task?.commentCount]);

  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setDescription(task.description);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!task) return null;

  const patch = (p: Partial<Task>) => run(() => api.patchTask(task.id, p));

  async function postComment(e: React.FormEvent) {
    e.preventDefault();
    const body = comment.trim();
    if (!body) return;
    setComment('');
    await run(() => api.comment(task!.id, body));
  }

  async function remove() {
    if (!window.confirm('Delete this task? This cannot be undone.')) return;
    onClose();
    await run(() => api.deleteTask(task!.id));
  }

  async function addLabel(e: React.FormEvent) {
    e.preventDefault();
    const name = labelName.trim();
    if (!name) return;
    setLabelName('');
    const palette = ['#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#db2777'];
    await run(async () => {
      const l = await api.createLabel(board.project.id, name, palette[board.labels.length % palette.length]!);
      await api.patchTask(task!.id, { labelIds: [...task!.labelIds, l.id] });
    });
  }

  const toggleLabel = (id: string) =>
    patch({ labelIds: task.labelIds.includes(id) ? task.labelIds.filter((x) => x !== id) : [...task.labelIds, id] });

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" aria-label="Task details">
        <header>
          <span className="task-key">{board.project.key}-{task.number}</span>
          <span className="spacer" />
          <button className="btn ghost danger" onClick={remove}>Delete</button>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </header>

        <input
          className="title-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title.trim() !== task.title && patch({ title: title.trim() })}
          aria-label="Title"
        />

        <div className="fields">
          <label>
            Status
            <select value={task.columnId} onChange={(e) => run(() => api.moveTask(task.id, e.target.value, board.tasks.filter((t) => t.columnId === e.target.value).length))}>
              {board.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label>
            Assignee
            <select value={task.assigneeId ?? ''} onChange={(e) => patch({ assigneeId: e.target.value || null })}>
              <option value="">Unassigned</option>
              {board.members.map((m) => <option key={m.id} value={m.id}>{m.name}{m.id === me.id ? ' (you)' : ''}</option>)}
            </select>
          </label>
          <label>
            Priority
            <select value={task.priority} onChange={(e) => patch({ priority: e.target.value as Priority })}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label>
            Due date
            <input type="date" value={task.dueDate ?? ''} onChange={(e) => patch({ dueDate: e.target.value || null })} />
          </label>
          <label>
            Estimate (hours)
            <input
              type="number" min="0" step="0.5"
              defaultValue={task.estimate ?? ''}
              onBlur={(e) => {
                const v = e.target.value === '' ? null : Number(e.target.value);
                if (v !== task.estimate) void patch({ estimate: v });
              }}
            />
          </label>
        </div>

        <section>
          <h4>Labels</h4>
          <div className="chips editable">
            {board.labels.map((l) => (
              <button
                key={l.id}
                className={`chip ${task.labelIds.includes(l.id) ? 'on' : ''}`}
                style={{ ['--chip' as string]: l.color }}
                onClick={() => toggleLabel(l.id)}
                aria-pressed={task.labelIds.includes(l.id)}
              >
                {l.name}
              </button>
            ))}
            <form onSubmit={addLabel}>
              <input className="label-input" placeholder="+ new label" value={labelName} onChange={(e) => setLabelName(e.target.value)} />
            </form>
          </div>
        </section>

        <section>
          <h4>Description</h4>
          <textarea
            rows={5}
            placeholder="Add more detail…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => description !== task.description && patch({ description })}
          />
        </section>

        {detail && detail.subtasks.length > 0 && (
          <section>
            <h4>Subtasks</h4>
            <ul className="subtasks">
              {detail.subtasks.map((s) => <li key={s.id}>{s.title}</li>)}
            </ul>
          </section>
        )}

        <section>
          <h4>Comments {detail ? `(${detail.comments.length})` : ''}</h4>
          <ul className="comments-list">
            {detail?.comments.map((c) => (
              <li key={c.id}>
                <Avatar user={{ id: c.authorId ?? '', name: userName(c.authorId) }} />
                <div>
                  <strong>{userName(c.authorId)}</strong> <small>{timeAgo(c.createdAt)}</small>
                  <p>{c.body}</p>
                </div>
              </li>
            ))}
          </ul>
          <form onSubmit={postComment} className="comment-form">
            <textarea
              rows={2}
              placeholder="Write a comment… (Ctrl+Enter to send)"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && postComment(e)}
            />
            <button className="btn primary" disabled={!comment.trim()}>Comment</button>
          </form>
        </section>

        <section>
          <h4>Activity</h4>
          <ul className="activity">
            {detail?.activity.map((a) => (
              <li key={a.id}>
                <strong>{userName(a.actorId)}</strong> {a.verb}{a.detail && a.verb !== 'commented' ? `: ${a.detail}` : ''} <small>{timeAgo(a.createdAt)}</small>
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </>
  );
}
