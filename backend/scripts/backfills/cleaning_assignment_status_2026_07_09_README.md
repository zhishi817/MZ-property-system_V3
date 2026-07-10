# Cleaning Assignment Status Backfill - 2026-07-09

This backfill fixes existing `cleaning_tasks` rows whose assignee fields already indicate an assigned task while `status` is still `pending`, `todo`, or `unassigned`.

Run the preview first:

```sql
\i backend/scripts/backfills/cleaning_assignment_status_2026_07_09_preview.sql
```

Apply only after reviewing the preview:

```sql
\i backend/scripts/backfills/cleaning_assignment_status_2026_07_09_apply.sql
```

The apply script only updates active `cleaning_tasks` rows in auto-assignable statuses. It does not touch `in_progress`, `cleaned`, `restock_pending`, `restocked`, `inspected`, `keys_hung`, `ready`, `completed`, `done`, `cancelled`, or `canceled`.
