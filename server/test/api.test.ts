import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app';
import { openDb } from '../src/db';

let base = '';
let server: ReturnType<ReturnType<typeof createApp>['listen']>;

async function api(method: string, url: string, token?: string, body?: unknown) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function signup(name: string, email: string) {
  const r = await api('POST', '/api/auth/signup', undefined, { name, email, password: 'correct horse' });
  assert.equal(r.status, 201);
  const me = await api('GET', '/api/me', r.body.token);
  return { token: r.body.token as string, user: r.body.user, workspaceId: me.body.workspaces[0].id as string };
}

before(async () => {
  server = createApp(openDb(':memory:')).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

describe('auth', () => {
  it('rejects bad signups and duplicate emails', async () => {
    assert.equal((await api('POST', '/api/auth/signup', undefined, { name: 'A', email: 'nope', password: 'longenough' })).status, 400);
    assert.equal((await api('POST', '/api/auth/signup', undefined, { name: 'A', email: 'a@x.io', password: 'short' })).status, 400);
    await signup('Dup', 'dup@x.io');
    assert.equal((await api('POST', '/api/auth/signup', undefined, { name: 'Dup', email: 'DUP@x.io', password: 'correct horse' })).status, 409);
  });

  it('logs in, and requires a token', async () => {
    await signup('Lou', 'lou@x.io');
    assert.equal((await api('POST', '/api/auth/login', undefined, { email: 'lou@x.io', password: 'wrong password' })).status, 401);
    const ok = await api('POST', '/api/auth/login', undefined, { email: 'lou@x.io', password: 'correct horse' });
    assert.equal(ok.status, 200);
    assert.equal((await api('GET', '/api/me')).status, 401);
  });
});

describe('projects and tasks', () => {
  let t: { token: string; workspaceId: string; user: { id: string } };
  let projectId: string;
  let cols: Array<{ id: string; name: string; isDone: boolean }>;

  before(async () => {
    t = await signup('Pat', 'pat@x.io');
    const p = await api('POST', `/api/workspaces/${t.workspaceId}/projects`, t.token, { name: 'Website Relaunch' });
    assert.equal(p.status, 201);
    assert.equal(p.body.key, 'WEBS');
    projectId = p.body.id;
    cols = (await api('GET', `/api/projects/${projectId}`, t.token)).body.columns;
  });

  it('creates default columns and labels', async () => {
    const b = (await api('GET', `/api/projects/${projectId}`, t.token)).body;
    assert.deepEqual(b.columns.map((c: any) => c.name), ['To do', 'In progress', 'Review', 'Done']);
    assert.equal(b.columns[3].isDone, true);
    assert.equal(b.labels.length, 3);
  });

  it('creates numbered tasks and validates input', async () => {
    const a = await api('POST', `/api/projects/${projectId}/tasks`, t.token, { title: 'First', priority: 'high' });
    const b = await api('POST', `/api/projects/${projectId}/tasks`, t.token, { title: 'Second', assigneeId: t.user.id });
    assert.equal(a.body.number, 1);
    assert.equal(b.body.number, 2);
    assert.equal(a.body.columnId, cols[0].id);
    assert.equal((await api('POST', `/api/projects/${projectId}/tasks`, t.token, { title: '  ' })).status, 400);
    assert.equal((await api('POST', `/api/projects/${projectId}/tasks`, t.token, { title: 'x', priority: 'asap' })).status, 400);
    assert.equal((await api('POST', `/api/projects/${projectId}/tasks`, t.token, { title: 'x', assigneeId: 'stranger' })).status, 400);
  });

  it('moves tasks between and within columns', async () => {
    const mk = async (title: string) => (await api('POST', `/api/projects/${projectId}/tasks`, t.token, { title, columnId: cols[1].id })).body.id as string;
    const [x, y, z] = [await mk('X'), await mk('Y'), await mk('Z')];
    await api('POST', `/api/tasks/${z}/move`, t.token, { columnId: cols[1].id, index: 0 });
    await api('POST', `/api/tasks/${x}/move`, t.token, { columnId: cols[3].id, index: 0 });
    const board = (await api('GET', `/api/projects/${projectId}`, t.token)).body;
    const titles = (colId: string) => board.tasks.filter((k: any) => k.columnId === colId).map((k: any) => k.title);
    assert.deepEqual(titles(cols[1].id), ['Z', 'Y']);
    assert.deepEqual(titles(cols[3].id), ['X']);
    const detail = (await api('GET', `/api/tasks/${x}`, t.token)).body;
    assert.ok(detail.activity.some((a: any) => a.verb === 'moved' && a.detail === 'In progress → Done'));
    assert.ok(y);
  });

  it('updates fields, labels and comments', async () => {
    const task = (await api('POST', `/api/projects/${projectId}/tasks`, t.token, { title: 'Edit me' })).body;
    const labels = (await api('GET', `/api/projects/${projectId}`, t.token)).body.labels;
    const patched = await api('PATCH', `/api/tasks/${task.id}`, t.token, {
      title: 'Edited', dueDate: '2026-12-01', estimate: 4, labelIds: [labels[0].id],
    });
    assert.equal(patched.body.title, 'Edited');
    assert.equal(patched.body.dueDate, '2026-12-01');
    assert.deepEqual(patched.body.labelIds, [labels[0].id]);
    assert.equal((await api('PATCH', `/api/tasks/${task.id}`, t.token, { dueDate: 'tomorrow' })).status, 400);
    await api('POST', `/api/tasks/${task.id}/comments`, t.token, { body: 'Looks good' });
    const detail = (await api('GET', `/api/tasks/${task.id}`, t.token)).body;
    assert.equal(detail.comments.length, 1);
    assert.equal(detail.task.commentCount, 1);
  });

  it('refuses to delete a column that still has tasks', async () => {
    assert.equal((await api('DELETE', `/api/columns/${cols[0].id}`, t.token)).status, 409);
    const added = await api('POST', `/api/projects/${projectId}/columns`, t.token, { name: 'Blocked' });
    assert.equal(added.status, 201);
    assert.equal((await api('DELETE', `/api/columns/${added.body.id}`, t.token)).status, 204);
  });

  it('keeps other workspaces out', async () => {
    const outsider = await signup('Eve', 'eve@x.io');
    assert.equal((await api('GET', `/api/projects/${projectId}`, outsider.token)).status, 404);
    const task = (await api('POST', `/api/projects/${projectId}/tasks`, t.token, { title: 'Private' })).body;
    assert.equal((await api('GET', `/api/tasks/${task.id}`, outsider.token)).status, 404);
    assert.equal((await api('DELETE', `/api/tasks/${task.id}`, outsider.token)).status, 404);
  });

  it('adds teammates by email and lets them be assigned', async () => {
    const mate = await signup('Sam', 'sam@x.io');
    assert.equal((await api('POST', `/api/workspaces/${t.workspaceId}/members`, t.token, { email: 'ghost@x.io' })).status, 404);
    assert.equal((await api('POST', `/api/workspaces/${t.workspaceId}/members`, t.token, { email: 'sam@x.io' })).status, 201);
    assert.equal((await api('GET', `/api/projects/${projectId}`, mate.token)).status, 200);
    const task = await api('POST', `/api/projects/${projectId}/tasks`, t.token, { title: 'For Sam', assigneeId: mate.user.id });
    assert.equal(task.status, 201);
    // members cannot invite
    assert.equal((await api('POST', `/api/workspaces/${t.workspaceId}/members`, mate.token, { email: 'pat@x.io' })).status, 403);
  });
});
