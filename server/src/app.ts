import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { hashPassword, newToken, verifyPassword } from './auth';
import { EventHub } from './events';

type Row = Record<string, any>;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
const DEFAULT_COLUMNS: Array<[string, number]> = [
  ['To do', 0],
  ['In progress', 0],
  ['Review', 0],
  ['Done', 1],
];
const DEFAULT_LABELS: Array<[string, string]> = [
  ['Bug', '#dc2626'],
  ['Feature', '#2563eb'],
  ['Chore', '#6b7280'],
];
const GAP = 1024;

function str(v: unknown, field: string, { max = 200, optional = false } = {}): string {
  if (typeof v !== 'string' || (!optional && v.trim() === '')) {
    throw new HttpError(400, `${field} is required`);
  }
  if (v.length > max) throw new HttpError(400, `${field} is too long`);
  return v.trim();
}

export function createApp(db: DatabaseSync, opts: { webDist?: string } = {}) {
  const app = express();
  const hub = new EventHub();
  app.use(express.json({ limit: '1mb' }));

  const all = (sql: string, ...p: any[]) => db.prepare(sql).all(...p) as Row[];
  const get = (sql: string, ...p: any[]) => db.prepare(sql).get(...p) as Row | undefined;
  const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);
  const now = () => new Date().toISOString();
  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  // ---------- auth middleware & access helpers ----------
  const uid = (req: Request): string => (req as any).userId;

  const auth = (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : (req.query.token as string | undefined);
    const session = token ? get('SELECT user_id FROM sessions WHERE token = ?', token) : undefined;
    if (!session) throw new HttpError(401, 'Unauthorized');
    (req as any).userId = session.user_id;
    next();
  };

  const roleIn = (userId: string, workspaceId: string): string | undefined =>
    get('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', workspaceId, userId)?.role;

  const workspaceFor = (req: Request, id: string, needAdmin = false) => {
    const ws = get('SELECT * FROM workspaces WHERE id = ?', id);
    const role = ws ? roleIn(uid(req), id) : undefined;
    if (!ws || !role) throw new HttpError(404, 'Workspace not found');
    if (needAdmin && role === 'member') throw new HttpError(403, 'Admin access required');
    return ws;
  };

  const projectFor = (req: Request, id: string): Row => {
    const p = get('SELECT * FROM projects WHERE id = ?', id);
    if (!p || !roleIn(uid(req), p.workspace_id)) throw new HttpError(404, 'Project not found');
    return p;
  };

  const taskFor = (req: Request, id: string): Row => {
    const t = get('SELECT * FROM tasks WHERE id = ?', id);
    if (!t) throw new HttpError(404, 'Task not found');
    projectFor(req, t.project_id);
    return t;
  };

  const columnFor = (req: Request, id: string): Row => {
    const c = get('SELECT * FROM columns WHERE id = ?', id);
    if (!c) throw new HttpError(404, 'Column not found');
    projectFor(req, c.project_id);
    return c;
  };

  const assertAssignee = (projectRow: Row, assigneeId: unknown) => {
    if (assigneeId == null) return;
    if (typeof assigneeId !== 'string' || !roleIn(assigneeId, projectRow.workspace_id)) {
      throw new HttpError(400, 'Assignee must be a workspace member');
    }
  };

  // ---------- DTOs ----------
  const userDto = (u: Row) => ({ id: u.id, name: u.name, email: u.email });
  const projectDto = (p: Row) => ({
    id: p.id,
    workspaceId: p.workspace_id,
    name: p.name,
    key: p.key,
    description: p.description,
  });
  const columnDto = (c: Row) => ({ id: c.id, projectId: c.project_id, name: c.name, position: c.position, isDone: !!c.is_done });
  const labelDto = (l: Row) => ({ id: l.id, name: l.name, color: l.color });
  const taskDto = (t: Row, labelIds: string[], commentCount: number) => ({
    id: t.id,
    projectId: t.project_id,
    columnId: t.column_id,
    number: t.number,
    title: t.title,
    description: t.description,
    priority: t.priority,
    assigneeId: t.assignee_id,
    dueDate: t.due_date,
    estimate: t.estimate,
    position: t.position,
    parentId: t.parent_id,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    labelIds,
    commentCount,
  });

  const loadTask = (id: string) => {
    const t = get('SELECT * FROM tasks WHERE id = ?', id)!;
    const labelIds = all('SELECT label_id FROM task_labels WHERE task_id = ?', id).map((r) => r.label_id as string);
    const count = get('SELECT COUNT(*) AS n FROM comments WHERE task_id = ?', id)!.n as number;
    return taskDto(t, labelIds, count);
  };

  const board = (projectId: string) => {
    const project = get('SELECT * FROM projects WHERE id = ?', projectId)!;
    const labelMap = new Map<string, string[]>();
    for (const r of all(
      'SELECT task_id, label_id FROM task_labels WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)',
      projectId,
    )) {
      labelMap.set(r.task_id, [...(labelMap.get(r.task_id) ?? []), r.label_id]);
    }
    const counts = new Map<string, number>(
      all(
        'SELECT task_id, COUNT(*) AS n FROM comments WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?) GROUP BY task_id',
        projectId,
      ).map((r) => [r.task_id as string, r.n as number]),
    );
    return {
      project: projectDto(project),
      columns: all('SELECT * FROM columns WHERE project_id = ? ORDER BY position', projectId).map(columnDto),
      tasks: all('SELECT * FROM tasks WHERE project_id = ? ORDER BY position', projectId).map((t) =>
        taskDto(t, labelMap.get(t.id) ?? [], counts.get(t.id) ?? 0),
      ),
      labels: all('SELECT * FROM labels WHERE project_id = ? ORDER BY name', projectId).map(labelDto),
      members: all(
        'SELECT u.* FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.workspace_id = ? ORDER BY u.name',
        project.workspace_id,
      ).map(userDto),
    };
  };

  const log = (projectId: string, taskId: string | null, actorId: string, verb: string, detail = '') =>
    run(
      'INSERT INTO activity (id, project_id, task_id, actor_id, verb, detail, created_at) VALUES (?,?,?,?,?,?,?)',
      randomUUID(), projectId, taskId, actorId, verb, detail, now(),
    );

  const changed = (projectId: string, actorId: string, type = 'changed') => hub.emit(projectId, { type, actorId });

  // ---------- ordering ----------
  const positionFor = (columnId: string, excludeTaskId: string | null, index: number): number => {
    const siblings = all(
      'SELECT id, position FROM tasks WHERE column_id = ? AND id <> ? ORDER BY position',
      columnId, excludeTaskId ?? '',
    );
    const i = Math.max(0, Math.min(index, siblings.length));
    const before = siblings[i - 1]?.position as number | undefined;
    const after = siblings[i]?.position as number | undefined;
    if (before === undefined && after === undefined) return GAP;
    if (before === undefined) return after! / 2;
    if (after === undefined) return before + GAP;
    return (before + after) / 2;
  };

  const rebalance = (columnId: string) => {
    all('SELECT id FROM tasks WHERE column_id = ? ORDER BY position', columnId).forEach((r, i) =>
      run('UPDATE tasks SET position = ? WHERE id = ?', (i + 1) * GAP, r.id),
    );
  };

  // ---------- auth routes ----------
  const startSession = (userId: string) => {
    const token = newToken();
    run('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)', token, userId, now());
    return token;
  };

  app.post('/api/auth/signup', (req, res) => {
    const name = str(req.body?.name, 'name', { max: 80 });
    const email = str(req.body?.email, 'email', { max: 200 }).toLowerCase();
    const password = str(req.body?.password, 'password', { max: 200 });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    if (get('SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'An account with that email already exists');

    const result = tx(() => {
      const userId = randomUUID();
      const wsId = randomUUID();
      run('INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?,?,?,?,?)', userId, name, email, hashPassword(password), now());
      run('INSERT INTO workspaces (id, name, created_at) VALUES (?,?,?)', wsId, `${name}'s workspace`, now());
      run("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?,?,'owner')", wsId, userId);
      return { userId, token: startSession(userId) };
    });
    res.status(201).json({ token: result.token, user: userDto(get('SELECT * FROM users WHERE id = ?', result.userId)!) });
  });

  app.post('/api/auth/login', (req, res) => {
    const email = str(req.body?.email, 'email').toLowerCase();
    const password = str(req.body?.password, 'password');
    const user = get('SELECT * FROM users WHERE email = ?', email);
    if (!user || !verifyPassword(password, user.password_hash)) throw new HttpError(401, 'Wrong email or password');
    res.json({ token: startSession(user.id), user: userDto(user) });
  });

  app.post('/api/auth/logout', auth, (req, res) => {
    const header = req.headers.authorization ?? '';
    run('DELETE FROM sessions WHERE token = ?', header.slice(7));
    res.status(204).end();
  });

  app.get('/api/me', auth, (req, res) => {
    const user = get('SELECT * FROM users WHERE id = ?', uid(req))!;
    const workspaces = all(
      'SELECT w.id, w.name, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at',
      uid(req),
    );
    res.json({ user: userDto(user), workspaces });
  });

  // ---------- workspaces ----------
  app.get('/api/workspaces/:id/members', auth, (req, res) => {
    workspaceFor(req, req.params.id as string);
    res.json(
      all(
        'SELECT u.*, m.role FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.workspace_id = ? ORDER BY u.name',
        req.params.id,
      ).map((u) => ({ ...userDto(u), role: u.role })),
    );
  });

  app.post('/api/workspaces/:id/members', auth, (req, res) => {
    workspaceFor(req, req.params.id as string, true);
    const email = str(req.body?.email, 'email').toLowerCase();
    const user = get('SELECT * FROM users WHERE email = ?', email);
    if (!user) throw new HttpError(404, 'No Herdr account with that email yet. Ask them to sign up first.');
    run("INSERT OR IGNORE INTO memberships (workspace_id, user_id, role) VALUES (?,?,'member')", req.params.id, user.id);
    res.status(201).json({ ...userDto(user), role: roleIn(user.id, req.params.id as string) });
  });

  // ---------- projects ----------
  app.get('/api/workspaces/:id/projects', auth, (req, res) => {
    workspaceFor(req, req.params.id as string);
    const rows = all(
      `SELECT p.*,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
        (SELECT COUNT(*) FROM tasks t JOIN columns c ON c.id = t.column_id WHERE t.project_id = p.id AND c.is_done = 1) AS done_count
       FROM projects p WHERE p.workspace_id = ? ORDER BY p.created_at`,
      req.params.id,
    );
    res.json(rows.map((p) => ({ ...projectDto(p), taskCount: p.task_count, doneCount: p.done_count })));
  });

  app.post('/api/workspaces/:id/projects', auth, (req, res) => {
    workspaceFor(req, req.params.id as string);
    const name = str(req.body?.name, 'name', { max: 80 });
    const description = str(req.body?.description ?? '', 'description', { max: 2000, optional: true });
    const base = (req.body?.key ? String(req.body.key) : name.replace(/[^A-Za-z]/g, '').slice(0, 4) || 'PRJ')
      .toUpperCase()
      .slice(0, 6);
    let key = base;
    for (let n = 2; get('SELECT 1 FROM projects WHERE workspace_id = ? AND key = ?', req.params.id, key); n++) key = `${base}${n}`;

    const id = tx(() => {
      const pid = randomUUID();
      run('INSERT INTO projects (id, workspace_id, name, key, description, created_at) VALUES (?,?,?,?,?,?)', pid, req.params.id, name, key, description, now());
      DEFAULT_COLUMNS.forEach(([n, done], i) =>
        run('INSERT INTO columns (id, project_id, name, position, is_done) VALUES (?,?,?,?,?)', randomUUID(), pid, n, (i + 1) * GAP, done),
      );
      DEFAULT_LABELS.forEach(([n, color]) => run('INSERT INTO labels (id, project_id, name, color) VALUES (?,?,?,?)', randomUUID(), pid, n, color));
      return pid;
    });
    res.status(201).json(projectDto(get('SELECT * FROM projects WHERE id = ?', id)!));
  });

  app.get('/api/projects/:id', auth, (req, res) => {
    projectFor(req, req.params.id as string);
    res.json(board(req.params.id as string));
  });

  app.patch('/api/projects/:id', auth, (req, res) => {
    const p = projectFor(req, req.params.id as string);
    const name = req.body?.name !== undefined ? str(req.body.name, 'name', { max: 80 }) : p.name;
    const description = req.body?.description !== undefined ? str(req.body.description, 'description', { max: 2000, optional: true }) : p.description;
    run('UPDATE projects SET name = ?, description = ? WHERE id = ?', name, description, p.id);
    changed(p.id, uid(req));
    res.json(projectDto(get('SELECT * FROM projects WHERE id = ?', p.id)!));
  });

  app.delete('/api/projects/:id', auth, (req, res) => {
    const p = projectFor(req, req.params.id as string);
    if (roleIn(uid(req), p.workspace_id) === 'member') throw new HttpError(403, 'Admin access required');
    run('DELETE FROM projects WHERE id = ?', p.id);
    res.status(204).end();
  });

  // ---------- columns ----------
  app.post('/api/projects/:id/columns', auth, (req, res) => {
    const p = projectFor(req, req.params.id as string);
    const name = str(req.body?.name, 'name', { max: 60 });
    const last = get('SELECT MAX(position) AS m FROM columns WHERE project_id = ?', p.id)?.m as number | null;
    const id = randomUUID();
    run('INSERT INTO columns (id, project_id, name, position, is_done) VALUES (?,?,?,?,?)', id, p.id, name, (last ?? 0) + GAP, req.body?.isDone ? 1 : 0);
    changed(p.id, uid(req));
    res.status(201).json(columnDto(get('SELECT * FROM columns WHERE id = ?', id)!));
  });

  app.patch('/api/columns/:id', auth, (req, res) => {
    const c = columnFor(req, req.params.id as string);
    const name = req.body?.name !== undefined ? str(req.body.name, 'name', { max: 60 }) : c.name;
    const isDone = req.body?.isDone !== undefined ? (req.body.isDone ? 1 : 0) : c.is_done;
    run('UPDATE columns SET name = ?, is_done = ? WHERE id = ?', name, isDone, c.id);
    changed(c.project_id, uid(req));
    res.json(columnDto(get('SELECT * FROM columns WHERE id = ?', c.id)!));
  });

  app.post('/api/columns/:id/move', auth, (req, res) => {
    const c = columnFor(req, req.params.id as string);
    const index = Number(req.body?.index);
    if (!Number.isInteger(index)) throw new HttpError(400, 'index is required');
    const others = all('SELECT id FROM columns WHERE project_id = ? AND id <> ? ORDER BY position', c.project_id, c.id);
    others.splice(Math.max(0, Math.min(index, others.length)), 0, { id: c.id });
    others.forEach((r, i) => run('UPDATE columns SET position = ? WHERE id = ?', (i + 1) * GAP, r.id));
    changed(c.project_id, uid(req));
    res.status(204).end();
  });

  app.delete('/api/columns/:id', auth, (req, res) => {
    const c = columnFor(req, req.params.id as string);
    if (get('SELECT COUNT(*) AS n FROM tasks WHERE column_id = ?', c.id)!.n) throw new HttpError(409, 'Move or delete the tasks in this column first');
    if (get('SELECT COUNT(*) AS n FROM columns WHERE project_id = ?', c.project_id)!.n === 1) throw new HttpError(409, 'A project needs at least one column');
    run('DELETE FROM columns WHERE id = ?', c.id);
    changed(c.project_id, uid(req));
    res.status(204).end();
  });

  // ---------- labels ----------
  app.post('/api/projects/:id/labels', auth, (req, res) => {
    const p = projectFor(req, req.params.id as string);
    const name = str(req.body?.name, 'name', { max: 40 });
    const color = str(req.body?.color ?? '#6b7280', 'color', { max: 9 });
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new HttpError(400, 'color must be a hex value like #2563eb');
    const id = randomUUID();
    run('INSERT INTO labels (id, project_id, name, color) VALUES (?,?,?,?)', id, p.id, name, color);
    changed(p.id, uid(req));
    res.status(201).json(labelDto(get('SELECT * FROM labels WHERE id = ?', id)!));
  });

  app.delete('/api/labels/:id', auth, (req, res) => {
    const l = get('SELECT * FROM labels WHERE id = ?', req.params.id);
    if (!l) throw new HttpError(404, 'Label not found');
    projectFor(req, l.project_id);
    run('DELETE FROM labels WHERE id = ?', l.id);
    changed(l.project_id, uid(req));
    res.status(204).end();
  });

  // ---------- tasks ----------
  const applyLabels = (task: Row, labelIds: unknown) => {
    if (!Array.isArray(labelIds)) throw new HttpError(400, 'labelIds must be an array');
    const valid = new Set(all('SELECT id FROM labels WHERE project_id = ?', task.project_id).map((l) => l.id as string));
    run('DELETE FROM task_labels WHERE task_id = ?', task.id);
    for (const id of new Set(labelIds)) {
      if (typeof id === 'string' && valid.has(id)) run('INSERT INTO task_labels (task_id, label_id) VALUES (?,?)', task.id, id);
    }
  };

  const checkFields = (b: Row) => {
    if (b.priority !== undefined && !PRIORITIES.includes(b.priority)) throw new HttpError(400, `priority must be one of ${PRIORITIES.join(', ')}`);
    if (b.dueDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(b.dueDate)) throw new HttpError(400, 'dueDate must be YYYY-MM-DD');
    if (b.estimate != null && (typeof b.estimate !== 'number' || b.estimate < 0)) throw new HttpError(400, 'estimate must be a positive number of hours');
  };

  app.post('/api/projects/:id/tasks', auth, (req, res) => {
    const p = projectFor(req, req.params.id as string);
    const b = req.body ?? {};
    const title = str(b.title, 'title', { max: 300 });
    checkFields(b);
    assertAssignee(p, b.assigneeId);
    const column = b.columnId
      ? get('SELECT * FROM columns WHERE id = ? AND project_id = ?', b.columnId, p.id)
      : get('SELECT * FROM columns WHERE project_id = ? ORDER BY position LIMIT 1', p.id);
    if (!column) throw new HttpError(400, 'Unknown column');
    if (b.parentId != null && !get('SELECT 1 FROM tasks WHERE id = ? AND project_id = ?', b.parentId, p.id)) throw new HttpError(400, 'Unknown parent task');

    const id = tx(() => {
      const tid = randomUUID();
      const number = (get('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tasks WHERE project_id = ?', p.id)!.n as number);
      const bottom = (get('SELECT MAX(position) AS m FROM tasks WHERE column_id = ?', column.id)?.m as number | null) ?? 0;
      run(
        `INSERT INTO tasks (id, project_id, column_id, number, title, description, priority, assignee_id, due_date, estimate, position, parent_id, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        tid, p.id, column.id, number, title, str(b.description ?? '', 'description', { max: 20000, optional: true }), b.priority ?? 'none',
        b.assigneeId ?? null, b.dueDate ?? null, b.estimate ?? null, bottom + GAP, b.parentId ?? null, uid(req), now(), now(),
      );
      if (b.labelIds) applyLabels({ id: tid, project_id: p.id }, b.labelIds);
      log(p.id, tid, uid(req), 'created', title);
      return tid;
    });
    changed(p.id, uid(req));
    res.status(201).json(loadTask(id));
  });

  app.get('/api/tasks/:id', auth, (req, res) => {
    const t = taskFor(req, req.params.id as string);
    res.json({
      task: loadTask(t.id),
      comments: all('SELECT * FROM comments WHERE task_id = ? ORDER BY created_at', t.id).map((c) => ({
        id: c.id, authorId: c.author_id, body: c.body, createdAt: c.created_at,
      })),
      activity: all('SELECT * FROM activity WHERE task_id = ? ORDER BY created_at DESC LIMIT 50', t.id).map((a) => ({
        id: a.id, actorId: a.actor_id, verb: a.verb, detail: a.detail, createdAt: a.created_at,
      })),
      subtasks: all('SELECT id, title, column_id FROM tasks WHERE parent_id = ? ORDER BY position', t.id).map((s) => ({
        id: s.id, title: s.title, columnId: s.column_id,
      })),
    });
  });

  app.patch('/api/tasks/:id', auth, (req, res) => {
    const t = taskFor(req, req.params.id as string);
    const p = projectFor(req, t.project_id);
    const b = req.body ?? {};
    checkFields(b);
    if (b.assigneeId !== undefined) assertAssignee(p, b.assigneeId);

    const columns: Record<string, string> = {
      title: 'title', description: 'description', priority: 'priority',
      assigneeId: 'assignee_id', dueDate: 'due_date', estimate: 'estimate',
    };
    tx(() => {
      const sets: string[] = [];
      const values: any[] = [];
      for (const [key, col] of Object.entries(columns)) {
        if (b[key] === undefined) continue;
        let v = b[key];
        if (key === 'title') v = str(v, 'title', { max: 300 });
        if (key === 'description') v = str(v, 'description', { max: 20000, optional: true });
        sets.push(`${col} = ?`);
        values.push(v);
        if (key !== 'description' && String(v ?? '') !== String(t[col] ?? '')) {
          log(p.id, t.id, uid(req), `changed ${key}`, `${t[col] ?? 'none'} → ${v ?? 'none'}`);
        }
      }
      if (sets.length) run(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...values, now(), t.id);
      if (b.labelIds !== undefined) {
        applyLabels(t, b.labelIds);
        run('UPDATE tasks SET updated_at = ? WHERE id = ?', now(), t.id);
      }
    });
    changed(p.id, uid(req));
    res.json(loadTask(t.id));
  });

  app.post('/api/tasks/:id/move', auth, (req, res) => {
    const t = taskFor(req, req.params.id as string);
    const column = get('SELECT * FROM columns WHERE id = ? AND project_id = ?', req.body?.columnId, t.project_id);
    const index = Number(req.body?.index);
    if (!column) throw new HttpError(400, 'Unknown column');
    if (!Number.isInteger(index)) throw new HttpError(400, 'index is required');

    tx(() => {
      let pos = positionFor(column.id, t.id, index);
      if (pos <= 1e-6) {
        rebalance(column.id);
        pos = positionFor(column.id, t.id, index);
      }
      run('UPDATE tasks SET column_id = ?, position = ?, updated_at = ? WHERE id = ?', column.id, pos, now(), t.id);
      if (column.id !== t.column_id) {
        const from = get('SELECT name FROM columns WHERE id = ?', t.column_id)?.name;
        log(t.project_id, t.id, uid(req), 'moved', `${from} → ${column.name}`);
      }
    });
    changed(t.project_id, uid(req));
    res.json(loadTask(t.id));
  });

  app.delete('/api/tasks/:id', auth, (req, res) => {
    const t = taskFor(req, req.params.id as string);
    run('DELETE FROM tasks WHERE id = ?', t.id);
    changed(t.project_id, uid(req));
    res.status(204).end();
  });

  app.post('/api/tasks/:id/comments', auth, (req, res) => {
    const t = taskFor(req, req.params.id as string);
    const body = str(req.body?.body, 'body', { max: 10000 });
    const id = randomUUID();
    run('INSERT INTO comments (id, task_id, author_id, body, created_at) VALUES (?,?,?,?,?)', id, t.id, uid(req), body, now());
    log(t.project_id, t.id, uid(req), 'commented', body.slice(0, 80));
    changed(t.project_id, uid(req));
    const c = get('SELECT * FROM comments WHERE id = ?', id)!;
    res.status(201).json({ id: c.id, authorId: c.author_id, body: c.body, createdAt: c.created_at });
  });

  // ---------- live updates (SSE) ----------
  app.get('/api/projects/:id/events', auth, (req, res) => {
    const p = projectFor(req, req.params.id as string);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const unsubscribe = hub.subscribe(p.id, res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // ---------- built web app (production) ----------
  if (opts.webDist && existsSync(opts.webDist)) {
    app.use(express.static(opts.webDist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(opts.webDist!, 'index.html')));
  }

  // ---------- errors ----------
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof SyntaxError) return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}
