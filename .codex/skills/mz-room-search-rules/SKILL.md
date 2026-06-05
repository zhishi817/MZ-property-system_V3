---
name: mz-room-search-rules
description: Use when building or updating any room/property number search, 房号搜索, 房号提示, autocomplete, or Select options in MZ Property System and the suggestions must come from the live properties database, exclude archived properties, and be ordered by region then room code.
---

# MZ Room Search Rules

Use this skill when the user asks to adjust room/property search suggestions in this repo, especially for deep-cleaning, maintenance, upload forms, admin filters, or public forms.

## Goal

Keep room suggestions consistent with the live `properties` data:

- source options from database-backed property records
- exclude archived properties from suggestion lists
- order by `region` first, then by room code
- avoid page-local hardcoded room arrays or ad hoc sort logic

## Repo Facts

1. `GET /properties` excludes archived rows by default. Only pass `include_archived=true` when a page explicitly needs archived properties for back-office history handling.
2. `frontend/src/lib/properties.ts` already exports `sortPropertiesByRegionThenCode(...)` and the repo's current region order.
3. Several current pages still use `sortProperties(...)`. When the requirement is "房号搜索提示按区域显示", prefer `sortPropertiesByRegionThenCode(...)`.
4. The source of truth is the `properties` dataset, not distinct room codes derived from cleaning, maintenance, or finance records.

## Workflow

1. Find the owning surface first. If the page is unclear, use `$mz-property-system-map`.
2. Load room options from `/properties` or another database-backed property endpoint.
3. Keep archived rooms out of new-search suggestions.
4. Normalize options from property rows, typically:
   - `value: property.id`
   - `label: property.code || property.address || property.id`
   - `region: property.region || ''`
5. Sort the dataset with `sortPropertiesByRegionThenCode(...)`.
6. If the UI supports grouped options, group by `region` in the same region order. If not, keep one flat list but still sort by region then room code.
7. Search matching can use the rendered label and, when useful, region text; the source dataset must still be the non-archived property list.

## Guardrails

1. Do not hardcode room numbers in page files.
2. Do not build suggestion lists from historical business records when the requirement is "follow database room records".
3. Do not request archived properties and then rely on client-only filtering unless the page truly needs archived data for another purpose.
4. Do not fall back to room-code-only ordering when the requirement explicitly says area/region order.
5. Prefer shared helpers in `frontend/src/lib/properties.ts` over page-local comparator functions.

## Archived Record Exception

If an existing record already references an archived property, keep that bound value readable in detail or edit flows when needed for history integrity. Even in that case, archived properties should not appear in the normal suggestion list for new selection.

## Good Files To Check

Read `references/current-surfaces.md` when the task is "which current pages likely need this rule".

