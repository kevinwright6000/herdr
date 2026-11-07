import { useMemo, useState } from 'react';
import { formatDue, PRIORITY_RANK, todayISO } from './lib';
import type { Board } from './types';
import { Avatar, LabelChip, PriorityBadge } from './ui';

type SortKey = 'number' | 'title' | 'status' | 'assignee' | 'priority' | 'due';

export default function ListView({
  board, visible, onOpen, onMove,
}: {
  board: Board;
  visible: Set<string>;
  onOpen: (id: string) => void;
  onMove: (taskId: string, columnId: string, index: number) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'number', dir: 1 });

  const rows = useMemo(() => {
    const colIndex = new Map(board.columns.map((c, i) => [c.id, i]));
    const name = (id: string | null) => board.members.find((m) => m.id === id)?.name ?? '￿';
    const val = (t: Board['tasks'][number]): string | number => {
      switch (sort.key) {
        case 'number': return t.number;
        case 'title': return t.title.toLowerCase();
        case 'status': return colIndex.get(t.columnId) ?? 0;
        case 'assignee': return name(t.assigneeId).toLowerCase();
        case 'priority': return PRIORITY_RANK[t.priority];
        case 'due': return t.dueDate ?? '9999-99-99';
      }
    };
    return board.tasks
      .filter((t) => visible.has(t.id))
      .sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * sort.dir);
  }, [board, visible, sort]);

  const th = (key: SortKey, label: string) => (
    <th>
      <button
        className="sort"
        onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}
        aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
      >
        {label} {sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : ''}
      </button>
    </th>
  );

  if (rows.length === 0) return <div className="empty small">No tasks match. Add some from the board view.</div>;

  return (
    <div className="list-wrap">
      <table className="list">
        <thead>
          <tr>
            {th('number', 'Key')}
            {th('title', 'Title')}
            {th('status', 'Status')}
            {th('assignee', 'Assignee')}
            {th('priority', 'Priority')}
            {th('due', 'Due')}
            <th>Labels</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const assignee = board.members.find((m) => m.id === t.assigneeId);
            const col = board.columns.find((c) => c.id === t.columnId);
            const overdue = !!t.dueDate && t.dueDate < todayISO() && !col?.isDone;
            return (
              <tr key={t.id} onClick={() => onOpen(t.id)}>
                <td className="task-key">{board.project.key}-{t.number}</td>
                <td className="title-cell">{t.title}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <select
                    value={t.columnId}
                    aria-label={`Status of ${t.title}`}
                    onChange={(e) => onMove(t.id, e.target.value, board.tasks.filter((x) => x.columnId === e.target.value).length)}
                  >
                    {board.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </td>
                <td>{assignee ? <span className="who"><Avatar user={assignee} size={20} /> {assignee.name}</span> : <span className="muted">—</span>}</td>
                <td><PriorityBadge priority={t.priority} /></td>
                <td className={overdue ? 'overdue' : ''}>{t.dueDate ? formatDue(t.dueDate) : <span className="muted">—</span>}</td>
                <td>{board.labels.filter((l) => t.labelIds.includes(l.id)).map((l) => <LabelChip key={l.id} label={l} />)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
