-- Simulates three users against the real policies and rolls everything back.
-- Run in the Supabase SQL editor. Success = an error whose message starts with
-- "RESULTS:" and contains no "(BAD)" marker.
do $$
declare
  u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); u3 uuid := gen_random_uuid();
  ws1 uuid; p public.projects; cols uuid[]; ta uuid; tb uuid; tc uuid;
  res text := ''; n int;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (u1, 'u1@test.io', '{"name":"Una Owner"}'),
    (u2, 'u2@test.io', '{"name":"Dee Member"}'),
    (u3, 'u3@test.io', '{"name":"Eve Outsider"}');
  select workspace_id into ws1 from public.memberships where user_id = u1;
  res := res || format('[signup] profiles=%s memberships=%s; ',
    (select count(*) from public.profiles where id in (u1,u2,u3)),
    (select count(*) from public.memberships where user_id in (u1,u2,u3)));

  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  p := public.create_project(ws1, 'Website Relaunch');
  select array_agg(id order by position) into cols from public.board_columns where project_id = p.id;
  res := res || format('[project] key=%s cols=%s labels=%s; ', p.key, array_length(cols, 1),
    (select count(*) from public.labels where project_id = p.id));

  insert into public.tasks (project_id, column_id, title) values (p.id, cols[1], 'A') returning id into ta;
  insert into public.tasks (project_id, column_id, title) values (p.id, cols[1], 'B') returning id into tb;
  insert into public.tasks (project_id, column_id, title) values (p.id, cols[1], 'C') returning id into tc;
  res := res || format('[numbers] %s; ', (select string_agg(number::text, ',' order by number) from public.tasks where project_id = p.id));

  perform public.move_task(tc, cols[1], 0);
  res := res || format('[move C to top] %s; ', (select string_agg(title, ',' order by position) from public.tasks where column_id = cols[1]));
  perform public.move_task(ta, cols[4], 0);
  res := res || format('[move A to Done] todo=%s done=%s; ',
    (select string_agg(title, ',' order by position) from public.tasks where column_id = cols[1]),
    (select string_agg(title, ',' order by position) from public.tasks where column_id = cols[4]));
  update public.tasks set priority = 'high', title = 'A renamed' where id = ta;
  res := res || format('[activity] %s; ', (select string_agg(verb || ' (' || detail || ')', ' | ' order by verb) from public.activity where task_id = ta));
  begin
    insert into public.projects (workspace_id, name, key) values (ws1, 'x', 'X');
    res := res || '[direct project insert] ALLOWED (BAD); ';
  exception when others then res := res || '[direct project insert] blocked; '; end;
  begin
    update public.tasks set number = 99 where id = tb;
    res := res || '[edit task number] ALLOWED (BAD); ';
  exception when others then res := res || '[edit task number] blocked; '; end;

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  res := res || format('[outsider sees] projects=%s tasks=%s columns=%s profiles=%s; ',
    (select count(*) from public.projects), (select count(*) from public.tasks),
    (select count(*) from public.board_columns), (select count(*) from public.profiles));
  begin
    insert into public.tasks (project_id, column_id, title) values (p.id, cols[1], 'hack');
    res := res || '[outsider insert] ALLOWED (BAD); ';
  exception when others then res := res || '[outsider insert] blocked (' || sqlerrm || '); '; end;
  update public.tasks set title = 'hacked' where id = tb;
  get diagnostics n = row_count;
  res := res || format('[outsider update rows] %s; ', n);
  begin
    perform public.add_member(ws1, 'u3@test.io');
    res := res || '[outsider add_member] ALLOWED (BAD); ';
  exception when others then res := res || '[outsider add_member] blocked (' || sqlerrm || '); '; end;
  begin
    perform public.move_task(tb, cols[2], 0);
    res := res || '[outsider move] ALLOWED (BAD); ';
  exception when others then res := res || '[outsider move] blocked (' || sqlerrm || '); '; end;

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.add_member(ws1, 'U2@test.io');
  begin
    perform public.add_member(ws1, 'nobody@test.io');
    res := res || '[add unknown email] ALLOWED (BAD); ';
  exception when others then res := res || '[add unknown email] ' || sqlerrm || '; '; end;

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  res := res || format('[member sees] projects=%s tasks=%s profiles=%s; ',
    (select count(*) from public.projects), (select count(*) from public.tasks), (select count(*) from public.profiles));
  insert into public.comments (task_id, body) values (tb, 'hello');
  res := res || format('[comment author is me] %s; ', (select author_id = u2 from public.comments where task_id = tb));
  begin
    insert into public.comments (task_id, body, author_id) values (tb, 'spoof', u1);
    res := res || '[spoofed comment author] ALLOWED (BAD); ';
  exception when others then res := res || '[spoofed comment author] blocked; '; end;
  begin
    update public.tasks set assignee_id = u3 where id = tb;
    res := res || '[assign non-member] ALLOWED (BAD); ';
  exception when others then res := res || '[assign non-member] blocked (' || sqlerrm || '); '; end;
  update public.tasks set assignee_id = u1 where id = tb;
  res := res || format('[assign member activity] %s; ', (select detail from public.activity where task_id = tb and verb = 'changed assignee'));
  begin
    perform public.add_member(ws1, 'u3@test.io');
    res := res || '[member add_member] ALLOWED (BAD); ';
  exception when others then res := res || '[member add_member] blocked; '; end;
  res := res || format('[summary view] %s; ', (select task_count || ' tasks, ' || done_count || ' done' from public.project_summaries where id = p.id));

  reset role;
  set local role anon;
  begin
    perform count(*) from public.tasks;
    res := res || '[anon read tasks] ALLOWED (BAD); ';
  exception when others then res := res || '[anon read tasks] blocked; '; end;

  reset role;
  raise exception 'RESULTS: %', res;
end $$;
