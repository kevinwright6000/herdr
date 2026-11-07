import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useState } from 'react';
import { api } from './api';
import { formatDue, todayISO } from './lib';
import type { Board as BoardData, Column, Task } from './types';
import { Avatar, LabelChip, PriorityBadge } from './ui';

interface Props {
  board: BoardData;
  visible: Set<string>;
  onOpen: (id: string) => void;
  onMove: (taskId: string, columnId: string, index: number) => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}

export default function Board({ board, visible, onOpen, onMove, run }: Props) {
  const [dragging, setDragging] = useState<Task | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);
  const [columnName, setColumnName] = useState('');
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const tasksIn = (columnId: string) =>
    board.tasks.filter((t) => t.columnId === columnId).sort((a, b) => a.position - b.position);

  function onDragStart(e: DragStartEvent) {
    setDragging(board.tasks.find((t) => t.id === e.active.id) ?? null);
  }

  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const task = board.tasks.find((t) => t.id === active.id);
    if (!task) return;

    const overId = String(over.id);
    let columnId: string;
    let index: number;
    if (overId.startsWith('col:')) {
      columnId = overId.slice(4);
      index = tasksIn(columnId).filter((t) => t.id !== task.id).length; // dropped on a column: append
    } else {
      const target = board.tasks.find((t) => t.id === overId);
      if (!target) return;
      columnId = target.columnId;
      const list = tasksIn(columnId);
      const overIndex = list.findIndex((t) => t.id === target.id);
      const activeIndex = list.findIndex((t) => t.id === task.id);
      const movingDown = columnId === task.columnId && activeIndex < overIndex;
      index = list.filter((t) => t.id !== task.id).findIndex((t) => t.id === target.id) + (movingDown ? 1 : 0);
    }
    onMove(task.id, columnId, index);
  }

  async function addColumn(e: React.FormEvent) {
    e.preventDefault();
    if (!columnName.trim()) return;
    await run(() => api.createColumn(board.project.id, columnName.trim()));
    setColumnName('');
    setAddingColumn(false);
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div className="board">
        {board.columns.map((col) => (
          <ColumnView key={col.id} column={col} tasks={tasksIn(col.id)} visible={visible} board={board} onOpen={onOpen} run={run} />
        ))}
        <div className="column add-column">
          {addingColumn ? (
            <form onSubmit={addColumn}>
              <input
                autoFocus
                placeholder="Column name"
                value={columnName}
                onChange={(e) => setColumnName(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setAddingColumn(false)}
              />
            </form>
          ) : (
            <button className="btn ghost" onClick={() => setAddingColumn(true)}>+ Add column</button>
          )}
        </div>
      </div>
      <DragOverlay>{dragging ? <Card task={dragging} board={board} overlay /> : null}</DragOverlay>
    </DndContext>
  );
}

function ColumnView({
  column, tasks, visible, board, onOpen, run,
}: {
  column: Column;
  tasks: Task[];
  visible: Set<string>;
  board: BoardData;
  onOpen: (id: string) => void;
  run: Props['run'];
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${column.id}` });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const shown = tasks.filter((t) => visible.has(t.id));

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    setTitle('');
    await run(() => api.createTask(board.project.id, { title: t, columnId: column.id }));
  }

  async function rename() {
    const name = window.prompt('Rename column', column.name)?.trim();
    if (name) await run(() => api.patchColumn(column.id, { name }));
  }

  return (
    <section className={`column ${isOver ? 'over' : ''}`}>
      <header>
        <h3 onDoubleClick={rename} title="Double-click to rename">
          {column.name} {column.isDone && <span className="done-mark" title="Tasks here count as done">✓</span>}
        </h3>
        <span className="count">{shown.length}{shown.length !== tasks.length ? `/${tasks.length}` : ''}</span>
        <button
          className="icon-btn"
          title={column.isDone ? 'Stop counting this column as done' : 'Count this column as done'}
          onClick={() => run(() => api.patchColumn(column.id, { isDone: !column.isDone }))}
        >
          ✓
        </button>
        {tasks.length === 0 && (
          <button className="icon-btn" title="Delete empty column" onClick={() => run(() => api.deleteColumn(column.id))}>×</button>
        )}
      </header>
      <SortableContext items={shown.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div className="cards" ref={setNodeRef}>
          {shown.map((t) => (
            <SortableCard key={t.id} task={t} board={board} onOpen={onOpen} />
          ))}
        </div>
      </SortableContext>
      {adding ? (
        <form onSubmit={add} className="quick-add">
          <input
            autoFocus
            placeholder="What needs doing? Press Enter"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => !title && setAdding(false)}
            onKeyDown={(e) => e.key === 'Escape' && setAdding(false)}
          />
        </form>
      ) : (
        <button className="btn ghost add-task" onClick={() => setAdding(true)}>+ Add task</button>
      )}
    </section>
  );
}

function SortableCard({ task, board, onOpen }: { task: Task; board: BoardData; onOpen: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.35 : 1 }}
      {...attributes}
      {...listeners}
    >
      <Card task={task} board={board} onOpen={onOpen} />
    </div>
  );
}

function Card({ task, board, onOpen, overlay }: { task: Task; board: BoardData; onOpen?: (id: string) => void; overlay?: boolean }) {
  const assignee = board.members.find((m) => m.id === task.assigneeId);
  const labels = board.labels.filter((l) => task.labelIds.includes(l.id));
  const col = board.columns.find((c) => c.id === task.columnId);
  const overdue = !!task.dueDate && task.dueDate < todayISO() && !col?.isDone;
  return (
    <article className={`card ${overlay ? 'overlay' : ''}`} onClick={() => onOpen?.(task.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen?.(task.id)}>
      {labels.length > 0 && (
        <div className="chips">{labels.map((l) => <LabelChip key={l.id} label={l} />)}</div>
      )}
      <div className="card-title">{task.title}</div>
      <div className="card-meta">
        <span className="task-key">{board.project.key}-{task.number}</span>
        <PriorityBadge priority={task.priority} />
        {task.dueDate && <span className={`due ${overdue ? 'overdue' : ''}`}>{formatDue(task.dueDate)}</span>}
        {task.commentCount > 0 && <span className="comments" title="Comments">💬 {task.commentCount}</span>}
        <span className="spacer" />
        {assignee && <Avatar user={assignee} size={22} />}
      </div>
    </article>
  );
}
