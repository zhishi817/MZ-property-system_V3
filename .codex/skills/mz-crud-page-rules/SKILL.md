---
name: mz-crud-page-rules
description: Use when building or updating backend CRUD pages in MZ Property System and the page should follow the repository's standard list, drawer, action order, form, submission, numbering, and display rules.
---

# MZ CRUD Page Rules

Use this skill for new or refactored backend CRUD pages under `frontend/src/app`.

## Goal

Keep admin CRUD pages visually and behaviorally consistent across the repo.

## Default Page Shape

1. Prefer one main page with:
   - top filter area when needed
   - one primary create action
   - one main list/table
2. Do not add extra tabs unless the workflow is genuinely multi-surface.

## Detail And Edit

1. Detail should default to a right-side `Drawer`.
2. Edit should default to a right-side `Drawer`.
3. Create should usually reuse the same form container as edit.
4. If detail supports editing, detail should expose `取消` and `编辑`, and `编辑` should open the edit drawer.

## Row Actions

Default row action order:

- `详情`
- `编辑`
- `删除`

Only add extra actions such as `下载`, `作废`, `审批`, or `导出` when the business flow actually needs them.

Keep row actions on one line whenever possible.

## Forms And Repeating Lines

1. Reuse the same create/edit form structure where possible.
2. Auto-filled business fields should not be manually editable.
3. Repeating detail lines should prefer a compact table-like layout with one header row and multiple input rows.
4. Avoid stacking each detail line inside oversized cards unless the line content is genuinely complex.

## Submission And Deletion

1. Frontend must block duplicate submit with loading or guard logic.
2. Backend transaction failures must really rollback.
3. Do not allow "request failed but record still created" behavior.
4. Delete must require confirmation.
5. If delete or edit affects stock, balance, or downstream records, reversal and rewrite must happen in one transaction.

## Numbering And Display

1. Do not expose raw UUIDs as the main business identifier when a page represents a user-facing business record.
2. Prefer human-readable business numbers similar to purchase orders.
3. Lists, details, exports, and filenames should use the same business number.
4. Money formatting should be consistent within the page and any related export surface.

## Scope Boundary

This skill does not require every CRUD page to support:

- download buttons
- PDF export
- approval flows
- cancel/void flows

Those actions are optional and should be added only when the business case requires them.

## Confirmed Examples From This Repo

Use these as reference patterns:

- detail view moved from modal to right-side drawer
- edit view moved from modal to right-side drawer
- row actions normalized into a fixed order
- duplicate submit prevented on both frontend and backend
- backend stock failure must rollback instead of partially committing
- repeating line items use a header row plus multi-line input layout
- supplier-driven price fields are auto-filled from maintained price tables
- business document numbers replace UUID display
- list/detail/export amount formatting stays aligned

## When To Use Another Skill

- Use `$mz-property-system-map` to find which module, page, and API own the feature.
- Use this skill after the owning surface is known and the task is to build or refactor the actual CRUD page UI and interaction rules.
