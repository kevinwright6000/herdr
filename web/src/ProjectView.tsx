import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { supabase } from './supabase';
import Board from './Board';
import ListView from './ListView';
import TaskDrawer from './TaskDrawer';
import { positionFor } from './lib';
import type { Board as BoardData, Priority, User } from './types';

export interface Filters {
  q: string;
  assignee: string; // '' all | 'me' | 'none' | user id
  label: string;
  priority: '' | Priority;
}

const NO_FILTERS: Filters = { q: '', assignee: '', label: '', priority: '' };

export default function ProjectView({
  projectId,
  me,
  onProjectsChanged,
}: {
  projectId: string;
  me: User;
  onProjectsChanged: () => void;
}) {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<'board' | 'list'>(() => (localStorage.getItem('herdr.view') as 'board' | 'list') ?? 'board');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [openTask, setOpenTask] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setBoard(await api.board(projectId));
      setError('');
      onProjectsChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId, onProjectsChanged]);

  // Initial load + live updates from teammates.
  useEffect(() => {
    void reload();
    let timer: number | undefined;
    const ping = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void reload(), 150);
    };
    const scoped = (table: string) => ({ event: '*' as const, schema: 'public', table, filter: `project_id=eq.${projectId}` });
    const channel = supabase
      .channel(`project:${projectId}`)
      .on('postgres_changes', scoped('tasks'), ping)
      .on('postgres_changes', scoped('board_columns'), ping)
      .on('postgres_changes', scoped('labels'), ping)
      // Row-level security limits these two to projects you can see.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_labels' }, ping)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comments' }, ping)
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const setViewPersist = (v: 'board' | 'list') => {
    setView(v);
    localStorage.setItem('herdr.view', v);
  };

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        await reload();
      }
    },
    [reload],
  );

  const moveTask = useCallback(
    (taskId: string, columnId: string, index: number) => {
      setBoard((b) => {
        if (!b) return b;
        const siblings = b.tasks.filter((t) => t.columnId === columnId && t.id !== taskId).sort((x, y) => x.position - y.position);
        const position = positionFor(siblings, index);
        return { ...b, tasks: b.tasks.map((t) => (t.id === taskId ? { ...t, columnId, position } : t)) };
      });
      void run(() => api.moveTask(taskId, columnId, index));
    },
    [run],
  );

  const visible = useMemo(() => {
    if (!board) return new Set<string>();
    const q = filters.q.trim().toLowerCase();
    return new Set(
      board.tasks
        .filter((t) => {
          if (q && !`${board.project.key}-${t.number} ${t.title}`.toLowerCase().includes(q)) return false;
          if (filters.assignee === 'me' && t.assigneeId !== me.id) return false;
          if (filters.assignee === 'none' && t.assigneeId) return false;
          if (filters.assignee && !['me', 'none'].includes(filters.assignee) && t.assigneeId !== filters.assignee) return false;
          if (filters.label && !t.labelIds.includes(filters.label)) return false;
          if (filters.priority && t.priority !== filters.priority) return false;
          return true;
        })
        .map((t) => t.id),
    );
  }, [board, filters, me.id]);

  if (!board) return <div className="loading">{error || 'Loading…'}</div>;

  const done = board.tasks.filter((t) => board.columns.find((c) => c.id === t.columnId)?.isDone).length;
  const pct = board.tasks.length ? Math.round((done / board.tasks.length) * 100) : 0;
  const filtering = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);

  async function rename() {
    const name = window.prompt('Rename project', board!.project.name)?.trim();
    if (name) await run(() => api.renameProject(projectId, name));
  }

  async function remove() {
    if (!window.confirm(`Delete "${board!.project.name}" and all its tasks? This cannot be undone.`)) return;
    try {
      await api.deleteProject(projectId);
      window.location.hash = '';
      onProjectsChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="project">
      <header className="project-head">
        <div>
          <h1 onDoubleClick={rename} title="Double-click to rename">{board.project.name}</h1>
          <div className="progress" title={`${done} of ${board.tasks.length} tasks done`}>
            <div className="bar"><div style={{ width: `${pct}%` }} /></div>
            <span>{pct}% done · {board.tasks.length} tasks</span>
          </div>
        </div>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={view === 'board'} onClick={() => setViewPersist('board')}>Board</button>
          <button role="tab" aria-selected={view === 'list'} onClick={() => setViewPersist('list')}>List</button>
        </div>
        <button className="btn ghost danger" onClick={remove}>Delete project</button>
      </header>

      <div className="filters">
        <input
          type="search"
          placeholder="Search tasks…"
          value={filters.q}
          onChange={(e) => setFilters({ ...filters, q: e.target.value })}
        />
        <select value={filters.assignee} onChange={(e) => setFilters({ ...filters, assignee: e.target.value })} aria-label="Assignee">
          <option value="">Anyone</option>
          <option value="me">Assigned to me</option>
          <option value="none">Unassigned</option>
          {board.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <select value={filters.label} onChange={(e) => setFilters({ ...filters, label: e.target.value })} aria-label="Label">
          <option value="">Any label</option>
          {board.labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select value={filters.priority} onChange={(e) => setFilters({ ...filters, priority: e.target.value as Filters['priority'] })} aria-label="Priority">
          <option value="">Any priority</option>
          {(['urgent', 'high', 'medium', 'low'] as const).map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        {filtering && <button className="link" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>}
      </div>

      {error && <div className="error banner" role="alert">{error}</div>}

      {view === 'board' ? (
        <Board board={board} visible={visible} onOpen={setOpenTask} onMove={moveTask} run={run} />
      ) : (
        <ListView board={board} visible={visible} onOpen={setOpenTask} onMove={moveTask} />
      )}

      {openTask && (
        <TaskDrawer
          key={openTask}
          taskId={openTask}
          board={board}
          me={me}
          onClose={() => setOpenTask(null)}
          run={run}
        />
      )}
    </div>
  );
}
