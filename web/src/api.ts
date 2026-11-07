import type { Board, Column, Comment, Label, Member, ProjectSummary, Task, TaskDetail, User, Workspace } from './types';

const TOKEN_KEY = 'herdr.token';

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string | null) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) window.dispatchEvent(new Event('herdr:unauth'));
    throw new ApiError(res.status, data.error ?? 'Request failed');
  }
  return data as T;
}

export const api = {
  signup: (name: string, email: string, password: string) =>
    request<{ token: string; user: User }>('POST', '/api/auth/signup', { name, email, password }),
  login: (email: string, password: string) =>
    request<{ token: string; user: User }>('POST', '/api/auth/login', { email, password }),
  logout: () => request<void>('POST', '/api/auth/logout'),
  me: () => request<{ user: User; workspaces: Workspace[] }>('GET', '/api/me'),

  members: (ws: string) => request<Member[]>('GET', `/api/workspaces/${ws}/members`),
  addMember: (ws: string, email: string) => request<Member>('POST', `/api/workspaces/${ws}/members`, { email }),

  projects: (ws: string) => request<ProjectSummary[]>('GET', `/api/workspaces/${ws}/projects`),
  createProject: (ws: string, name: string) => request<ProjectSummary>('POST', `/api/workspaces/${ws}/projects`, { name }),
  board: (id: string) => request<Board>('GET', `/api/projects/${id}`),
  renameProject: (id: string, name: string) => request<ProjectSummary>('PATCH', `/api/projects/${id}`, { name }),
  deleteProject: (id: string) => request<void>('DELETE', `/api/projects/${id}`),

  createColumn: (project: string, name: string) => request<Column>('POST', `/api/projects/${project}/columns`, { name }),
  patchColumn: (id: string, patch: Partial<Pick<Column, 'name' | 'isDone'>>) => request<Column>('PATCH', `/api/columns/${id}`, patch),
  deleteColumn: (id: string) => request<void>('DELETE', `/api/columns/${id}`),

  createLabel: (project: string, name: string, color: string) =>
    request<Label>('POST', `/api/projects/${project}/labels`, { name, color }),

  createTask: (project: string, body: Partial<Task> & { title: string }) => request<Task>('POST', `/api/projects/${project}/tasks`, body),
  task: (id: string) => request<TaskDetail>('GET', `/api/tasks/${id}`),
  patchTask: (id: string, patch: Partial<Task>) => request<Task>('PATCH', `/api/tasks/${id}`, patch),
  moveTask: (id: string, columnId: string, index: number) => request<Task>('POST', `/api/tasks/${id}/move`, { columnId, index }),
  deleteTask: (id: string) => request<void>('DELETE', `/api/tasks/${id}`),
  comment: (id: string, body: string) => request<Comment>('POST', `/api/tasks/${id}/comments`, { body }),
};
