# Herdr

Project management that herds the cats for you. A fast kanban board with a list view, comments, labels, filters and live updates, built to be adopted in an afternoon.

**Stack:** React + TypeScript + Vite on Vercel, Supabase (Postgres, Auth, Realtime) for everything else. There is no custom server.

## Features

- **Kanban board:** drag and drop (mouse, touch or keyboard), quick-add, add/rename/delete columns, mark columns as "done" to drive progress
- **List view:** sortable table with inline status changes
- **Tasks:** assignee, priority, due date (overdue highlighting), estimate, labels, description, comments, activity history
- **Search and filters:** by text, assignee, label, priority
- **Live updates:** teammates' changes appear instantly (Supabase Realtime)
- **Workspaces and teams:** signup creates a workspace; admins add teammates by email
- **Security in the database:** row-level security means people only ever see their own workspaces' data
- Light and dark themes, responsive layout

## Setup

### 1. Database (once)

Create a Supabase project, then run the files in `supabase/migrations/` in order in the SQL editor (or with the Supabase CLI: `supabase db push`):

1. `20261107000001_schema.sql`: tables, triggers, functions
2. `20261107000002_security.sql`: row-level security, grants, realtime
3. `20261107000003_private_helpers.sql`: moves internal helpers out of the public API

In the Supabase dashboard under **Authentication → URL Configuration**, set **Site URL** to your deployed URL (for example `https://herdr.vercel.app`) and add `http://localhost:5173` to the redirect URLs. Email confirmation is on by default, so people confirm their address before their first login.

### 2. Web app

```bash
cp web/.env.example web/.env.local   # fill in your Supabase URL and anon/publishable key
npm install
npm run dev                          # http://localhost:5173
```

Both values are public by design (find them in **Project Settings → API**). Never use the `service_role` key in this app.

### 3. Deploy to Vercel

Import the repo and add the same two variables, `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, under **Settings → Environment Variables**. `vercel.json` already sets the build command and output directory.

## Project layout

```
web/                 React app (Vite, dnd-kit for drag and drop)
  src/api.ts         All Supabase calls
supabase/
  migrations/        Schema, security, helpers
  tests/permissions.sql   Simulates three users against the real policies, rolls back
```

`npm run typecheck` and `npm run build` check the app.

## How the data is protected

- Every table has row-level security. Access flows from workspace membership.
- Browser clients can only change what the policies and column grants allow. Task numbers, authorship and ownership are set by triggers, not by the client.
- Creating projects, adding teammates and reordering tasks go through small database functions (`create_project`, `add_member`, `move_task`) that check permissions themselves.
- `supabase/tests/permissions.sql` verifies this: outsiders see nothing, members cannot invite or delete projects, signed-out requests are blocked.

## Roadmap

Timeline and workload views, dependencies, custom fields, automations, templates, docs/wiki, email invites and notifications, SSO, API tokens and webhooks.
