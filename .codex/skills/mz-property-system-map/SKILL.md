---
name: mz-property-system-map
description: Map the MZ Property System codebase by resource ownership, page route, backend module, CRUD surface, workflow actions, and common pitfalls. Use when Codex needs to locate where a feature lives, determine whether a resource uses /crud or a dedicated module, trace a frontend page to its API calls, summarize system behavior for a business object, or avoid common false assumptions in this repo.
---

# MZ Property System Map

Use this skill to orient quickly inside the MZ Property System repository.

This map is based on the repo snapshot around 2026-04-07. When behavior seems inconsistent, re-check `backend/src/modules/crud.ts`, `backend/src/index.ts`, `frontend/src/app`, and `mz-cleaning-app-frontend/src` before assuming the map is still current.

## Decision Tree

1. Identify which app surface the user is asking about.
   - Next.js admin app: check `references/frontend-entrypoints.md` first.
   - Expo cleaning app: check `references/frontend-entrypoints.md` for the mobile section, then `references/backend-route-patterns.md` for `/cleaning-app` and `/mzapp`.
   - Backend/API question: check `references/backend-route-patterns.md` first.

2. Identify the resource type.
   - Standard resource CRUD or `/crud` resource: check `references/crud-map.md`.
   - Dedicated business module with richer actions: check `references/backend-route-patterns.md`.
   - Subresource such as rules, items, fees, links, deductions, or line items: check `references/crud-map.md` and confirm the parent module.
   - Workflow action such as import, upload, review, publish, issue, PDF, share-link, or task completion: do not reduce it to CRUD. Check `references/backend-route-patterns.md` and `references/anti-patterns.md`.

3. Decide whether `/crud` is truly the right layer.
   - If the resource is listed in the `/crud` allowlist, that only means generic CRUD may exist.
   - Still confirm whether the page actually calls `/crud` or calls a dedicated module directly.
   - If there are uploads, PDFs, reviews, public links, issue/void flows, or import flows, expect dedicated routes.

## Workflow

1. Start from the user-facing object name.
2. Find the resource row in `references/crud-map.md`.
3. Confirm the real frontend entrypoint in `references/frontend-entrypoints.md`.
4. Confirm the backend mount and action shape in `references/backend-route-patterns.md`.
5. Scan `references/anti-patterns.md` before answering so you do not give the user a misleading shortcut.

## What To Read

- Read `references/crud-map.md` when the task is "where is this resource created/read/updated/deleted".
- Read `references/frontend-entrypoints.md` when the task is "which page owns this flow" or "what does this screen call".
- Read `references/backend-route-patterns.md` when the task is "which router/module should I edit" or "is this CRUD or workflow".
- Read `references/anti-patterns.md` when the task involves assumptions, refactors, or implementation planning.
- Read `$mz-crud-page-rules` when the task is to build or refactor a backend CRUD page and the page should follow the repository's standard UI and interaction rules.

## Output Format

When answering with this skill, prefer this structure:

- `Resource`: canonical object name
- `Ownership`: `/crud`, dedicated module, public flow, or mobile task flow
- `Frontend`: main page or screen entrypoint
- `Backend`: router mount and key routes
- `Actions`: CRUD plus special actions
- `Pitfalls`: 1-2 repo-specific warnings

## Maintenance Notes

Update this skill when any of the following changes:

- `backend/src/modules/crud.ts` allowlist or CRUD behavior
- `backend/src/index.ts` route mounts
- `frontend/src/app` page structure
- `mz-cleaning-app-frontend/src/lib/api.ts` URL patterns or task flows

Keep `SKILL.md` short. Put large tables and repo facts in `references/` files rather than duplicating them here.
