import { useCallback, useEffect, useState } from 'react';
import { api, getToken, setToken } from './api';
import AuthPage from './AuthPage';
import ProjectView from './ProjectView';
import type { Member, ProjectSummary, User, Workspace } from './types';
import { Avatar, Logo, Modal } from './ui';

const routeId = () => /^#\/p\/(.+)$/.exec(window.location.hash)?.[1] ?? null;

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [booting, setBooting] = useState(!!getToken());
  const [projectId, setProjectId] = useState<string | null>(routeId());
  const [newName, setNewName] = useState<string | null>(null);
  const [teamOpen, setTeamOpen] = useState(false);

  const loadMe = useCallback(async () => {
    try {
      const me = await api.me();
      setUser(me.user);
      setWorkspace(me.workspaces[0] ?? null);
    } catch {
      setToken(null);
    } finally {
      setBooting(false);
    }
  }, []);

  useEffect(() => {
    if (getToken()) void loadMe();
    const onHash = () => setProjectId(routeId());
    const onUnauth = () => {
      setToken(null);
      setUser(null);
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('herdr:unauth', onUnauth);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('herdr:unauth', onUnauth);
    };
  }, [loadMe]);

  const loadProjects = useCallback(async () => {
    if (!workspace) return;
    setProjects(await api.projects(workspace.id));
  }, [workspace]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // Land on the first project when nothing is selected.
  useEffect(() => {
    if (!projectId && projects[0]) window.location.hash = `#/p/${projects[0].id}`;
  }, [projectId, projects]);

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    if (!workspace || !newName?.trim()) return;
    const p = await api.createProject(workspace.id, newName.trim());
    setNewName(null);
    await loadProjects();
    window.location.hash = `#/p/${p.id}`;
  }

  async function logout() {
    await api.logout().catch(() => undefined);
    setToken(null);
    setUser(null);
    setProjects([]);
    window.location.hash = '';
  }

  if (booting) return <div className="splash"><Logo size={48} /></div>;
  if (!user || !workspace) {
    return (
      <AuthPage
        onAuthed={(u) => {
          setUser(u);
          void loadMe();
        }}
      />
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Logo />
          <span>Herdr</span>
        </div>
        <div className="ws-name">{workspace.name}</div>
        <nav>
          {projects.map((p) => {
            const pct = p.taskCount ? Math.round(((p.doneCount ?? 0) / p.taskCount) * 100) : 0;
            return (
              <a key={p.id} href={`#/p/${p.id}`} className={p.id === projectId ? 'active' : ''}>
                <span className="proj-key">{p.key}</span>
                <span className="proj-name">{p.name}</span>
                <span className="proj-pct" title={`${p.doneCount ?? 0} of ${p.taskCount ?? 0} done`}>{pct}%</span>
              </a>
            );
          })}
        </nav>
        {newName === null ? (
          <button className="btn ghost" onClick={() => setNewName('')}>+ New project</button>
        ) : (
          <form onSubmit={createProject} className="new-project">
            <input
              autoFocus
              placeholder="Project name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setNewName(null)}
            />
          </form>
        )}
        <div className="spacer" />
        <button className="btn ghost" onClick={() => setTeamOpen(true)}>Team</button>
        <div className="me">
          <Avatar user={user} />
          <span>{user.name}</span>
          <button className="link" onClick={logout}>Log out</button>
        </div>
      </aside>
      <main>
        {projectId ? (
          <ProjectView key={projectId} projectId={projectId} me={user} onProjectsChanged={loadProjects} />
        ) : (
          <div className="empty">
            <h2>Welcome to Herdr</h2>
            <p>Create your first project to get a kanban board.</p>
            <button className="btn primary" onClick={() => setNewName('')}>New project</button>
          </div>
        )}
      </main>
      {teamOpen && <TeamModal workspace={workspace} onClose={() => setTeamOpen(false)} />}
    </div>
  );
}

function TeamModal({ workspace, onClose }: { workspace: Workspace; onClose: () => void }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const canInvite = workspace.role !== 'member';

  const load = useCallback(() => api.members(workspace.id).then(setMembers), [workspace.id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api.addMember(workspace.id, email);
      setEmail('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal title="Team" onClose={onClose}>
      <ul className="members">
        {members.map((m) => (
          <li key={m.id}>
            <Avatar user={m} size={28} />
            <div>
              <strong>{m.name}</strong>
              <small>{m.email}</small>
            </div>
            <span className="role">{m.role}</span>
          </li>
        ))}
      </ul>
      {canInvite ? (
        <form onSubmit={invite} className="invite">
          <input type="email" placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <button className="btn primary">Add</button>
          {error && <div className="error">{error}</div>}
          <small>They need a Herdr account first. Email invitations are on the roadmap.</small>
        </form>
      ) : (
        <small>Only workspace admins can add people.</small>
      )}
    </Modal>
  );
}
