-- Herdr schema: tables, helper functions, triggers and RPCs.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null,
  email text not null,
  created_at timestamptz not null default now()
);
create unique index profiles_email_key on public.profiles (lower(email));

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.memberships (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  primary key (workspace_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  key text not null,
  description text not null default '' check (length(description) <= 2000),
  task_counter integer not null default 0,
  created_at timestamptz not null default now(),
  unique (workspace_id, key)
);

create table public.board_columns (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  position double precision not null,
  is_done boolean not null default false
);
create index board_columns_project_idx on public.board_columns (project_id, position);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  column_id uuid not null references public.board_columns (id),
  number integer not null,
  title text not null check (length(trim(title)) between 1 and 300),
  description text not null default '' check (length(description) <= 20000),
  priority text not null default 'none' check (priority in ('none', 'low', 'medium', 'high', 'urgent')),
  assignee_id uuid references public.profiles (id) on delete set null,
  due_date date,
  estimate numeric check (estimate is null or estimate >= 0),
  position double precision not null default 0,
  parent_id uuid references public.tasks (id) on delete cascade,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, number)
);
create index tasks_column_idx on public.tasks (column_id, position);
create index tasks_parent_idx on public.tasks (parent_id);
create index tasks_assignee_idx on public.tasks (assignee_id);

create table public.labels (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 40),
  color text not null check (color ~ '^#[0-9a-fA-F]{6}$')
);
create index labels_project_idx on public.labels (project_id);

create table public.task_labels (
  task_id uuid not null references public.tasks (id) on delete cascade,
  label_id uuid not null references public.labels (id) on delete cascade,
  primary key (task_id, label_id)
);
create index task_labels_label_idx on public.task_labels (label_id);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  author_id uuid references public.profiles (id) on delete set null default auth.uid(),
  body text not null check (length(trim(body)) between 1 and 10000),
  created_at timestamptz not null default now()
);
create index comments_task_idx on public.comments (task_id, created_at);
create index comments_author_idx on public.comments (author_id);

create table public.activity (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  task_id uuid references public.tasks (id) on delete cascade,
  actor_id uuid references public.profiles (id) on delete set null,
  verb text not null,
  detail text not null default '',
  created_at timestamptz not null default now()
);
create index activity_task_idx on public.activity (task_id, created_at desc);
create index activity_project_idx on public.activity (project_id);
create index activity_actor_idx on public.activity (actor_id);

-- ---------- helpers used by row-level security ----------
create function public.is_member(ws uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships
    where workspace_id = ws and user_id = (select auth.uid())
  );
$$;

create function public.is_admin(ws uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships
    where workspace_id = ws and user_id = (select auth.uid()) and role in ('owner', 'admin')
  );
$$;

create function public.project_ws(pid uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select workspace_id from public.projects where id = pid;
$$;

create function public.task_project(tid uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select project_id from public.tasks where id = tid;
$$;

create function public.shares_workspace(other uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.memberships a
    join public.memberships b on b.workspace_id = a.workspace_id
    where a.user_id = (select auth.uid()) and b.user_id = other
  );
$$;

-- ---------- signup: profile + personal workspace ----------
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid;
  nm text;
begin
  nm := coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), split_part(new.email, '@', 1));
  insert into public.profiles (id, name, email) values (new.id, nm, new.email);
  insert into public.workspaces (name) values (nm || '''s workspace') returning id into ws;
  insert into public.memberships (workspace_id, user_id, role) values (ws, new.id, 'owner');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- task integrity: numbering, ordering, ownership checks ----------
create function public.tasks_before_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ws uuid;
  col_project uuid;
begin
  ws := public.project_ws(new.project_id);
  if ws is null or not public.is_member(ws) then
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

create trigger tasks_before_write
  before insert or update on public.tasks
  for each row execute function public.tasks_before_write();

-- ---------- activity log ----------
create function public.tasks_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  a text;
  b text;
begin
  if tg_op = 'INSERT' then
    insert into public.activity (project_id, task_id, actor_id, verb, detail)
      values (new.project_id, new.id, actor, 'created', new.title);
    return new;
  end if;

  if new.column_id <> old.column_id then
    select name into a from public.board_columns where id = old.column_id;
    select name into b from public.board_columns where id = new.column_id;
    insert into public.activity (project_id, task_id, actor_id, verb, detail)
      values (new.project_id, new.id, actor, 'moved', a || ' → ' || b);
  end if;
  if new.title <> old.title then
    insert into public.activity (project_id, task_id, actor_id, verb, detail)
      values (new.project_id, new.id, actor, 'changed title', old.title || ' → ' || new.title);
  end if;
  if new.priority <> old.priority then
    insert into public.activity (project_id, task_id, actor_id, verb, detail)
      values (new.project_id, new.id, actor, 'changed priority', old.priority || ' → ' || new.priority);
  end if;
  if new.assignee_id is distinct from old.assignee_id then
    select name into a from public.profiles where id = old.assignee_id;
    select name into b from public.profiles where id = new.assignee_id;
    insert into public.activity (project_id, task_id, actor_id, verb, detail)
      values (new.project_id, new.id, actor, 'changed assignee', coalesce(a, 'nobody') || ' → ' || coalesce(b, 'nobody'));
  end if;
  if new.due_date is distinct from old.due_date then
    insert into public.activity (project_id, task_id, actor_id, verb, detail)
      values (new.project_id, new.id, actor, 'changed due date',
              coalesce(old.due_date::text, 'none') || ' → ' || coalesce(new.due_date::text, 'none'));
  end if;
  if new.estimate is distinct from old.estimate then
    insert into public.activity (project_id, task_id, actor_id, verb, detail)
      values (new.project_id, new.id, actor, 'changed estimate',
              coalesce(old.estimate::text, 'none') || ' → ' || coalesce(new.estimate::text, 'none'));
  end if;
  return new;
end;
$$;

create trigger tasks_log
  after insert or update on public.tasks
  for each row execute function public.tasks_log();

create function public.comments_log() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.activity (project_id, task_id, actor_id, verb, detail)
    select t.project_id, t.id, new.author_id, 'commented', left(new.body, 80)
    from public.tasks t where t.id = new.task_id;
  return new;
end;
$$;

create trigger comments_log
  after insert on public.comments
  for each row execute function public.comments_log();

-- ---------- RPCs ----------
create function public.create_project(ws uuid, p_name text, p_description text default '')
returns public.projects
language plpgsql security definer set search_path = '' as $$
declare
  base text;
  k text;
  n int := 2;
  r public.projects;
begin
  if not public.is_member(ws) then
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

create function public.add_member(ws uuid, p_email text)
returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare
  u public.profiles;
begin
  if not public.is_admin(ws) then
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

-- Runs as the caller, so row-level security still applies.
create function public.move_task(p_task uuid, p_column uuid, p_index int)
returns public.tasks
language plpgsql set search_path = '' as $$
declare
  t public.tasks;
  sibs double precision[];
  i int;
  before_p double precision;
  after_p double precision;
  pos double precision;
begin
  select * into t from public.tasks where id = p_task;
  if t.id is null then
    raise exception 'Task not found';
  end if;
  if not exists (select 1 from public.board_columns where id = p_column and project_id = t.project_id) then
    raise exception 'Unknown column';
  end if;

  select coalesce(array_agg(position order by position), '{}'::double precision[])
    into sibs from public.tasks where column_id = p_column and id <> p_task;
  i := greatest(0, least(p_index, coalesce(array_length(sibs, 1), 0)));
  before_p := case when i >= 1 then sibs[i] end;
  after_p := sibs[i + 1];
  pos := case
    when before_p is null and after_p is null then 1024
    when before_p is null then after_p / 2
    when after_p is null then before_p + 1024
    else (before_p + after_p) / 2
  end;

  update public.tasks set column_id = p_column, position = pos where id = p_task;

  -- Keep gaps healthy: renumber the column if neighbours got too close.
  if pos < 0.000001 or (before_p is not null and after_p is not null and after_p - before_p < 0.000001) then
    update public.tasks x set position = r.rn * 1024
      from (
        select id, row_number() over (order by position, id) as rn
        from public.tasks where column_id = p_column
      ) r
      where x.id = r.id;
  end if;

  select * into t from public.tasks where id = p_task;
  return t;
end;
$$;
