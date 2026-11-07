# Herdr

Project management that herds the cats for you. A fast kanban board with a list view, comments, labels, filters and live updates, built to be adopted in an afternoon.

## Features

- **Kanban board**: drag and drop tasks between and within columns (mouse, touch or keyboard), quick-add, add/rename/delete columns, mark columns as "done" to drive progress
- **List view**: sortable table with inline status changes
- **Tasks**: assignee, priority, due date (overdue highlighting), estimate, labels, description, comments, activity history
- **Search and filters**: by text, assignee, label, priority
- **Live updates**: teammates' changes appear instantly (Server-Sent Events)
- **Workspaces and teams**: signup creates a workspace; add teammates by email
- **Auth**: email + password (scrypt-hashed), session tokens
- Light and dark themes, responsive layout

## Quick start

Requires Node.js 22.5 or newer (uses the built-in `node:sqlite`).

```bash
npm install
npm run dev        # API on :4000, web app on http://localhost:5173
```

Production:

```bash
npm run build      # builds web/dist
npm start          # API + built app on http://localhost:4000
```

Or with Docker:

```bash
docker build -t herdr .
docker run -p 4000:4000 -v herdr-data:/data herdr
```

| Variable    | Default    | Purpose                  |
| ----------- | ---------- | ------------------------ |
| `PORT`      | `4000`     | HTTP port                |
| `HERDR_DB`  | `herdr.db` | SQLite database file     |

## Project layout

```
server/   Express 5 + SQLite REST API, SSE live updates, tests
web/      React + TypeScript + Vite single-page app (dnd-kit for drag and drop)
```

```bash
npm test           # API tests (node:test)
npm run typecheck  # server + web
```

## API sketch

All routes except signup/login need `Authorization: Bearer <token>`.

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/auth/signup`, `/api/auth/login` | Create account / sign in |
| GET | `/api/me` | Current user and workspaces |
| GET/POST | `/api/workspaces/:id/projects` | List / create projects |
| GET/POST | `/api/workspaces/:id/members` | List / add teammates |
| GET | `/api/projects/:id` | Whole board: columns, tasks, labels, members |
| POST | `/api/projects/:id/tasks` | Create task |
| PATCH | `/api/tasks/:id` | Update fields and labels |
| POST | `/api/tasks/:id/move` | `{ columnId, index }` reorder or change column |
| POST | `/api/tasks/:id/comments` | Add comment |
| GET | `/api/projects/:id/events` | SSE stream of change notifications |

Task ordering uses fractional positions, so a drag updates a single row.

## Roadmap

Timeline and workload views, dependencies, custom fields, automations, templates, docs/wiki, email invites and notifications, SSO, API tokens and webhooks. See the product spec for the full plan.
