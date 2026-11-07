-- Herdr security: row-level security, grants, summary view, realtime.

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.memberships enable row level security;
alter table public.projects enable row level security;
alter table public.board_columns enable row level security;
alter table public.tasks enable row level security;
alter table public.labels enable row level security;
alter table public.task_labels enable row level security;
alter table public.comments enable row level security;
alter table public.activity enable row level security;

-- profiles: see yourself and people you share a workspace with
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.shares_workspace(id));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- workspaces and memberships (membership changes go through add_member)
create policy workspaces_select on public.workspaces for select to authenticated
  using (public.is_member(id));
create policy workspaces_update on public.workspaces for update to authenticated
  using (public.is_admin(id)) with check (public.is_admin(id));
create policy memberships_select on public.memberships for select to authenticated
  using (public.is_member(workspace_id));

-- projects (creation goes through create_project)
create policy projects_select on public.projects for select to authenticated
  using (public.is_member(workspace_id));
create policy projects_update on public.projects for update to authenticated
  using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));
create policy projects_delete on public.projects for delete to authenticated
  using (public.is_admin(workspace_id));

-- project children: any workspace member
create policy board_columns_all on public.board_columns for all to authenticated
  using (public.is_member(public.project_ws(project_id)))
  with check (public.is_member(public.project_ws(project_id)));
create policy labels_all on public.labels for all to authenticated
  using (public.is_member(public.project_ws(project_id)))
  with check (public.is_member(public.project_ws(project_id)));
create policy tasks_all on public.tasks for all to authenticated
  using (public.is_member(public.project_ws(project_id)))
  with check (public.is_member(public.project_ws(project_id)));

create policy task_labels_select on public.task_labels for select to authenticated
  using (public.is_member(public.project_ws(public.task_project(task_id))));
create policy task_labels_insert on public.task_labels for insert to authenticated
  with check (
    public.is_member(public.project_ws(public.task_project(task_id)))
    and exists (
      select 1 from public.labels l
      where l.id = label_id and l.project_id = public.task_project(task_id)
    )
  );
create policy task_labels_delete on public.task_labels for delete to authenticated
  using (public.is_member(public.project_ws(public.task_project(task_id))));

create policy comments_select on public.comments for select to authenticated
  using (public.is_member(public.project_ws(public.task_project(task_id))));
create policy comments_insert on public.comments for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and public.is_member(public.project_ws(public.task_project(task_id)))
  );
create policy comments_delete on public.comments for delete to authenticated
  using (author_id = (select auth.uid()));

create policy activity_select on public.activity for select to authenticated
  using (public.is_member(public.project_ws(project_id)));

-- ---------- grants: signed-in users only, column-level where it matters ----------
revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on functions from anon;

grant select on public.profiles, public.workspaces, public.memberships, public.projects,
  public.board_columns, public.tasks, public.labels, public.task_labels, public.comments,
  public.activity to authenticated;
grant update (name) on public.profiles to authenticated;
grant update (name) on public.workspaces to authenticated;
grant update (name, description) on public.projects to authenticated;
grant delete on public.projects to authenticated;
grant insert (project_id, name, position, is_done), update (name, position, is_done), delete
  on public.board_columns to authenticated;
grant insert (project_id, name, color), update (name, color), delete on public.labels to authenticated;
grant insert (project_id, column_id, title, description, priority, assignee_id, due_date, estimate, parent_id),
      update (column_id, title, description, priority, assignee_id, due_date, estimate, position, parent_id),
      delete
  on public.tasks to authenticated;
grant insert, delete on public.task_labels to authenticated;
grant insert (task_id, body), delete on public.comments to authenticated;

-- functions: nothing callable by anon; trigger functions not callable at all
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.is_member(uuid), public.is_admin(uuid), public.project_ws(uuid),
  public.task_project(uuid), public.shares_workspace(uuid),
  public.create_project(uuid, text, text), public.add_member(uuid, text),
  public.move_task(uuid, uuid, int)
  to authenticated;

-- ---------- project list with progress ----------
create view public.project_summaries with (security_invoker = true) as
select
  p.id, p.workspace_id, p.name, p.key, p.description, p.created_at,
  (select count(*) from public.tasks t where t.project_id = p.id)::int as task_count,
  (select count(*) from public.tasks t
     join public.board_columns c on c.id = t.column_id
     where t.project_id = p.id and c.is_done)::int as done_count
from public.projects p;
grant select on public.project_summaries to authenticated;

-- ---------- realtime ----------
alter publication supabase_realtime add table
  public.tasks, public.board_columns, public.labels, public.task_labels,
  public.comments, public.projects, public.memberships;
