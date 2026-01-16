# Cleaning Tasks Module

## Core Goals
- Provide end-to-end cleaning task lifecycle for cleaners: list, start with media+geo, report issues, submit consumables, restock, inspection complete (lockbox video), set ready.
- Keep auto-derived tasks from orders, while allowing manual tasks. Respect `locked` and `auto_managed` flags.

## Data Model (Postgres)
- Table: `cleaning_tasks`
  - Columns: `id text PK`, `order_id text NULL`, `type text`, `property_id text`, `date date`, `status text`, `assignee_id text`, `scheduled_at timestamptz`, `old_code text`, `new_code text`, `note text`, `checkout_time text`, `checkin_time text`, plus management flags and media timestamps (`auto_managed`, `locked`, `reschedule_required`, `started_at`, `finished_at`, `key_photo_uploaded_at`, `lockbox_video_uploaded_at`, `geo_lat`, `geo_lng`, `cleaned`, `restocked`, `inspected`).
  - Unique: `(order_id, type) WHERE order_id IS NOT NULL`.

## Permissions
- App routes require: `cleaning_app.calendar.view.all|cleaning_app.tasks.view.self`, `cleaning_app.tasks.start`, `cleaning_app.issues.report`, `cleaning_app.tasks.finish`, `cleaning_app.restock.manage`, `cleaning_app.inspect.finish`, `cleaning_app.ready.set`.

## API
- GET `/cleaning-app/tasks`
  - Query: `assignee_id?`, `from? YYYY-MM-DD`, `to? YYYY-MM-DD`, `status?`
  - Returns array of tasks.
- POST `/cleaning-app/tasks/:id/start`
  - Body: `{ media_url: string, captured_at?, lat?, lng? }`
  - Effect: `status=in_progress`, set `started_at`, `key_photo_uploaded_at`, optional geo; create `cleaning_task_media` record.
- POST `/cleaning-app/tasks/:id/issues`
  - Body: `{ title: string, detail?, severity?, media_url? }`
  - Effect: insert `cleaning_issues` and optional media.
- POST `/cleaning-app/tasks/:id/consumables`
  - Body: `{ items: [{ item_id, qty, need_restock?, note? }] }`
  - Effect: insert usages; set `status=cleaned|restock_pending` accordingly; `finished_at`.
- PATCH `/cleaning-app/tasks/:id/restock`
  - Effect: `status=restocked`.
- POST `/cleaning-app/tasks/:id/inspection-complete`
  - Body: `{ media_url: string, captured_at?, lat?, lng? }`
  - Effect: `status=inspected`, set `lockbox_video_uploaded_at`; insert media.
- PATCH `/cleaning-app/tasks/:id/ready`
  - Effect: `status=ready`.
- POST `/cleaning-app/upload`
  - FormData: `file`
  - Returns: `{ url }` stored in R2 or `/uploads/`.

## Status Machine (simplified)
- `pending` → `scheduled` → `in_progress` → `cleaned/restock_pending` → `restocked` → `inspected` → `ready` → terminal
- `canceled` can override any non-terminal if order cancelled.
- `locked/auto_managed=false` prevents auto changes except set `canceled` and marks `reschedule_required`.

## Interactions
- Orders import creates/updates derived tasks via `services/cleaningDerive.ts` and `modules/jobs.ts`.
- Manual tasks remain unaffected by order linkage when `order_id IS NULL`.

## Frontend (cleaning-frontend)
- Pages: `/login`, `/calendar`, `/info`, `/me`
- Components: `Header`, `BottomNav`, `TaskCard`
- Data loading: `/cleaning-app/tasks?from&to` with token; file uploads via `/cleaning-app/upload`.
- UI: day/week/month switch, date strip, task cards with actions.

## Error Handling
- 4xx for validation; 5xx for server errors.
- Frontend shows error blocks; redirects to `/login` without token.

## Usage
1. Login: POST `/auth/login`, store `token`.
2. List: GET `/cleaning-app/tasks?from=2026-01-15&to=2026-01-15`.
3. Start: upload file → POST `/tasks/:id/start` with url+geo.
4. Submit consumables: POST `/tasks/:id/consumables`.
5. Restock/Inspect/Ready: PATCH/POST respective endpoints.

## Testing
- See `backend/scripts/test_cleaning_tasks_module.js` for integration test runner.
- Provide tokens via `backend/tokenA_admin.json` or env `AUTH_TOKEN`.

## Notes
- Ensure `NEXT_PUBLIC_API_BASE` is set for frontend.
- DB migrations provided in `backend/scripts/migrations/20260115_cleaning_tasks_sync.sql`.

