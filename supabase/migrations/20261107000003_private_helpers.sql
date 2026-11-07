-- Move RLS helper functions out of the API-exposed `public` schema.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

alter function public.is_member(uuid) set schema private;
alter function public.is_admin(uuid) set schema private;
alter function public.project_ws(uuid) set schema private;
alter function public.task_project(uuid) set schema private;
alter function public.shares_workspace(uuid) set schema private;

-- Functions whose bodies call the helpers by name need to point at the new schema.
create or replace function public.tasks_before_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid;
  col_project uuid;
begin
  ws := private.project_ws(new.project_id);
  if ws is null or not private.is_member(ws) then
    raise exception 'Not allowed';
  end if;

  select project_id into col_project from public.board_columns where id = new.column_id;
  if col_project is distinct from new.project_id then
    raise exception 'Column does not belong to this project';
  end if;
  if new.assignee_id is not null and not exists (
    select 1 from public.memberships where workspace_id = ws and user_id = new.assignee_id
  ) then
    raise exception 'Assignee must be a workspace member';
  end if;
  if new.parent_id is not null and not exists (
    select 1 from public.tasks where id = new.parent_id and project_id = new.project_id
  ) then
    raise exception 'Parent task must be in the same project';
  end if;

  if tg_op = 'INSERT' then
    update public.projects set task_counter = task_counter + 1
      where id = new.project_id returning task_counter into new.number;
    new.created_by := (select auth.uid());
    new.created_at := now();
    if new.position = 0 then
      select coalesce(max(position), 0) + 1024 into new.position
        from public.tasks where column_id = new.column_id;
    end if;
  else
    new.number := old.number;
    new.project_id := old.project_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.create_project(ws uuid, p_name text, p_description text default '')
returns public.projects
language plpgsql security definer set search_path = '' as $$
declare
  base text;
  k text;
  n int := 2;
  r public.projects;
begin
  if not private.is_member(ws) then
    raise exception 'Workspace not found';
  end if;
  base := upper(left(coalesce(nullif(regexp_replace(p_name, '[^A-Za-z]', '', 'g'), ''), 'PRJ'), 4));
  k := base;
  while exists (select 1 from public.projects where workspace_id = ws and key = k) loop
    k := base || n;
    n := n + 1;
  end loop;
  insert into public.projects (workspace_id, name, key, description)
    values (ws, trim(p_name), k, coalesce(p_description, ''))
    returning * into r;
  insert into public.board_columns (project_id, name, position, is_done) values
    (r.id, 'To do', 1024, false),
    (r.id, 'In progress', 2048, false),
    (r.id, 'Review', 3072, false),
    (r.id, 'Done', 4096, true);
  insert into public.labels (project_id, name, color) values
    (r.id, 'Bug', '#dc2626'),
    (r.id, 'Feature', '#2563eb'),
    (r.id, 'Chore', '#6b7280');
  return r;
end;
$$;

create or replace function public.add_member(ws uuid, p_email text)
returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare
  u public.profiles;
begin
  if not private.is_admin(ws) then
    raise exception 'Admin access required';
  end if;
  select * into u from public.profiles where lower(email) = lower(trim(p_email));
  if u.id is null then
    raise exception 'No Herdr account with that email yet. Ask them to sign up first.';
  end if;
  insert into public.memberships (workspace_id, user_id, role)
    values (ws, u.id, 'member') on conflict do nothing;
  return u;
end;
$$;
