# Restore Keys-Hung Status Backfill

This production data repair restores cleaning tasks that were incorrectly
overwritten from `keys_hung` back to an ordinary scheduling status by the task
center save-board flow.

## Criteria

A row is a repair candidate only when all of these are true:

- `cleaning_tasks.status` is currently `assigned`, `pending`, `todo`,
  `scheduled`, or `in_progress`;
- `work_task_action_audits` contains a matching `upload_access_video` action
  whose `status_after` is `keys_hung`;
- the task still has a `lockbox_video` media row or a non-null
  `lockbox_video_uploaded_at`.

Rows where the lockbox video was deleted are intentionally skipped.

## Preview

Run:

`restore_keys_hung_status_2026_07_02_preview.sql`

Review every returned candidate before applying.

## Apply

Only after preview review, run:

`restore_keys_hung_status_2026_07_02_apply.sql`

The apply script runs in a transaction, updates matching candidates to
`status = 'keys_hung'`, and returns the updated rows.
