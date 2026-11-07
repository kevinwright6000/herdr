import { supabase } from './supabase';
import type { Board, Column, Comment, Label, Member, ProjectSummary, Task, TaskDetail, User, Workspace, ActivityItem } from './types';

const FRIENDLY: Record<string, string> = {
  '23503': 'Move or delete the tasks in this column first',
  '23505': 'That already exists',
  '23514': 'That value is not allowed',
  '42501': 'You do not have permission to do that',
  PGRST116: 'Not found, or you do not have access',
};

type DbError = { message: string; code?: string };

function fail(error: DbError): never {
  throw new Error((error.code && FRIENDLY[error.code]) || error.message);
}

async function unwrap<T>(query: PromiseLike<{ data: T | null; error: DbError | null }>): Promise<T> {
  const { data, error } = await query;
  if (error) fail(error);
  return data as T;
}

// ---------- row -> app type mappers ----------
const toUser = (r: any): User => ({ id: r.id, name: r.name, email: r.email });
const toProject = (r: any): ProjectSummary => ({
  id: r.id,
  workspaceId: r.workspace_id,
  name: r.name,
  key: r.key,
  description: r.description,
  ...(r.task_count !== undefined ? { taskCount: r.task_count, doneCount: r.done_count } : {}),
});
const toColumn = (r: any): Column => ({ id: r.id, projectId: r.project_id, name: r.name, position: r.position, isDone: r.is_done });
const toLabel = (r: any): Label => ({ id: r.id, name: r.name, color: r.color });
const toTask = (r: any): Task => ({
  id: r.id,
  projectId: r.project_id,
  columnId: r.column_id,
  number: r.number,
  title: r.title,
  description: r.description,
  priority: r.priority,
  assigneeId: r.assignee_id,
  dueDate: r.due_date,
  estimate: r.estimate == null ? null : Number(r.estimate),
  position: r.position,
  parentId: r.parent_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  labelIds: (r.task_labels ?? []).map((l: any) => l.label_id),
  commentCount: r.comments?.[0]?.count ?? 0,
});

const TASK_SELECT = '*, task_labels(label_id), comments(count)';

const TASK_COLUMNS: Record<string, string> = {
  title: 'title',
  description: 'description',
  priority: 'priority',
  assigneeId: 'assignee_id',
  dueDate: 'due_date',
  estimate: 'estimate',
};

export const api = {
  // ----- auth -----
  /** Resolves with whether the person must confirm their email before they can log in. */
  async signup(name: string, email: string, password: string): Promise<{ needsConfirmation: boolean }> {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name }, emailRedirectTo: window.location.origin },
    });
    if (error) fail(error);
    return { needsConfirmation: !data.session };
  },
  async login(email: string, password: string): Promise<void> {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) fail(error);
  },
  async logout(): Promise<void> {
    await supabase.auth.signOut();
  },
  async me(): Promise<{ user: User; workspaces: Workspace[] }> {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error('Not signed in');
    const [profile, memberships] = await Promise.all([
      unwrap<any>(supabase.from('profiles').select('id, name, email').eq('id', user.id).single()),
      unwrap<any[]>(supabase.from('memberships').select('role, workspaces(id, name, created_at)').eq('user_id', user.id)),
    ]);
    const workspaces = memberships
      .map((m) => ({ id: m.workspaces.id, name: m.workspaces.name, role: m.role, createdAt: m.workspaces.created_at }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(({ id, name, role }) => ({ id, name, role }));
    return { user: toUser(profile), workspaces };
  },

  // ----- workspace -----
  async members(ws: string): Promise<Member[]> {
    const rows = await unwrap<any[]>(supabase.from('memberships').select('role, profiles(id, name, email)').eq('workspace_id', ws));
    return rows.map((r) => ({ ...toUser(r.profiles), role: r.role })).sort((a, b) => a.name.localeCompare(b.name));
  },
  async addMember(ws: string, email: string): Promise<void> {
    await unwrap(supabase.rpc('add_member', { ws, p_email: email }));
  },

  // ----- projects -----
  async projects(ws: string): Promise<ProjectSummary[]> {
    const rows = await unwrap<any[]>(supabase.from('project_summaries').select('*').eq('workspace_id', ws).order('created_at'));
    return rows.map(toProject);
  },
  async createProject(ws: string, name: string): Promise<ProjectSummary> {
    return toProject(await unwrap<any>(supabase.rpc('create_project', { ws, p_name: name })));
  },
  async board(id: string): Promise<Board> {
    const project = await unwrap<any>(supabase.from('projects').select('*').eq('id', id).single());
    const [columns, tasks, labels, members] = await Promise.all([
      unwrap<any[]>(supabase.from('board_columns').select('*').eq('project_id', id).order('position')),
      unwrap<any[]>(supabase.from('tasks').select(TASK_SELECT).eq('project_id', id).order('position')),
      unwrap<any[]>(supabase.from('labels').select('*').eq('project_id', id).order('name')),
      unwrap<any[]>(supabase.from('memberships').select('profiles(id, name, email)').eq('workspace_id', project.workspace_id)),
    ]);
    return {
      project: toProject(project),
      columns: columns.map(toColumn),
      tasks: tasks.map(toTask),
      labels: labels.map(toLabel),
      members: members.map((m) => toUser(m.profiles)).sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
  async renameProject(id: string, name: string): Promise<void> {
    await unwrap(supabase.from('projects').update({ name }).eq('id', id).select('id').single());
  },
  async deleteProject(id: string): Promise<void> {
    const rows = await unwrap<any[]>(supabase.from('projects').delete().eq('id', id).select('id'));
    if (rows.length === 0) throw new Error('Only workspace admins can delete projects');
  },

  // ----- columns & labels -----
  async createColumn(project: string, name: string): Promise<void> {
    const last = await unwrap<any[]>(
      supabase.from('board_columns').select('position').eq('project_id', project).order('position', { ascending: false }).limit(1),
    );
    await unwrap(supabase.from('board_columns').insert({ project_id: project, name, position: (last[0]?.position ?? 0) + 1024 }));
  },
  async patchColumn(id: string, patch: Partial<Pick<Column, 'name' | 'isDone'>>): Promise<void> {
    const row: Record<string, unknown> = {};
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.isDone !== undefined) row.is_done = patch.isDone;
    await unwrap(supabase.from('board_columns').update(row).eq('id', id));
  },
  async deleteColumn(id: string): Promise<void> {
    await unwrap(supabase.from('board_columns').delete().eq('id', id));
  },
  async createLabel(project: string, name: string, color: string): Promise<Label> {
    return toLabel(await unwrap<any>(supabase.from('labels').insert({ project_id: project, name, color }).select().single()));
  },

  // ----- tasks -----
  async createTask(project: string, body: Partial<Task> & { title: string }): Promise<void> {
    let columnId = body.columnId;
    if (!columnId) {
      const first = await unwrap<any[]>(supabase.from('board_columns').select('id').eq('project_id', project).order('position').limit(1));
      columnId = first[0]?.id;
    }
    const row: Record<string, unknown> = { project_id: project, column_id: columnId, title: body.title };
    for (const [key, col] of Object.entries(TASK_COLUMNS)) {
      if (key !== 'title' && (body as any)[key] !== undefined) row[col] = (body as any)[key];
    }
    if (body.parentId) row.parent_id = body.parentId;
    await unwrap(supabase.from('tasks').insert(row));
  },
  async task(id: string): Promise<TaskDetail> {
    const [task, comments, activity, subtasks] = await Promise.all([
      unwrap<any>(supabase.from('tasks').select(TASK_SELECT).eq('id', id).single()),
      unwrap<any[]>(supabase.from('comments').select('id, author_id, body, created_at').eq('task_id', id).order('created_at')),
      unwrap<any[]>(
        supabase.from('activity').select('id, actor_id, verb, detail, created_at').eq('task_id', id).order('created_at', { ascending: false }).limit(50),
      ),
      unwrap<any[]>(supabase.from('tasks').select('id, title, column_id').eq('parent_id', id).order('position')),
    ]);
    return {
      task: toTask(task),
      comments: comments.map((c): Comment => ({ id: c.id, authorId: c.author_id, body: c.body, createdAt: c.created_at })),
      activity: activity.map((a): ActivityItem => ({ id: a.id, actorId: a.actor_id, verb: a.verb, detail: a.detail, createdAt: a.created_at })),
      subtasks: subtasks.map((s) => ({ id: s.id, title: s.title, columnId: s.column_id })),
    };
  },
  async patchTask(id: string, patch: Partial<Task>): Promise<void> {
    const row: Record<string, unknown> = {};
    for (const [key, col] of Object.entries(TASK_COLUMNS)) {
      if (key in patch) row[col] = (patch as any)[key];
    }
    if (Object.keys(row).length) {
      const rows = await unwrap<any[]>(supabase.from('tasks').update(row).eq('id', id).select('id'));
      if (rows.length === 0) throw new Error('Task not found, or you do not have access');
    }
    if (patch.labelIds) {
      const current = (await unwrap<any[]>(supabase.from('task_labels').select('label_id').eq('task_id', id))).map((r) => r.label_id as string);
      const want = new Set(patch.labelIds);
      const add = [...want].filter((l) => !current.includes(l));
      const remove = current.filter((l) => !want.has(l));
      if (add.length) await unwrap(supabase.from('task_labels').insert(add.map((label_id) => ({ task_id: id, label_id }))));
      if (remove.length) await unwrap(supabase.from('task_labels').delete().eq('task_id', id).in('label_id', remove));
    }
  },
  async moveTask(id: string, columnId: string, index: number): Promise<void> {
    await unwrap(supabase.rpc('move_task', { p_task: id, p_column: columnId, p_index: index }));
  },
  async deleteTask(id: string): Promise<void> {
    await unwrap(supabase.from('tasks').delete().eq('id', id));
  },
  async comment(id: string, body: string): Promise<void> {
    await unwrap(supabase.from('comments').insert({ task_id: id, body }));
  },
};
