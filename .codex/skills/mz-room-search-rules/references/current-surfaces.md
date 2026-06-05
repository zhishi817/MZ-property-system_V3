# Current Surfaces

Use this reference when the user wants to know where room/property search suggestions currently live.

## Shared Helpers And API

- `frontend/src/lib/properties.ts`
  - `sortProperties(...)`
  - `sortPropertiesByRegionThenCode(...)`
- `backend/src/modules/properties.ts`
  - `GET /properties`
  - archived properties are excluded by default unless `include_archived=true`

## Current Pages Using Property Selects That Are Good Review Targets

- `frontend/src/app/deep-cleaning/records/page.tsx`
- `frontend/src/app/deep-cleaning/upload/page.tsx`
- `frontend/src/app/deep-cleaning/overview/page.tsx`
- `frontend/src/app/maintenance/records/page.tsx`
- `frontend/src/app/maintenance/progress/page.tsx`
- `frontend/src/app/public/deep-cleaning-upload/page.tsx`
- `frontend/src/app/public/maintenance-progress/page.tsx`
- `frontend/src/app/public/repair-report/page.tsx`

## Fast Search Patterns

- `rg -n "sortProperties\\(" frontend/src/app`
- `rg -n "placeholder=\\\"房号|房号搜索|label=\\\"房号\\\"" frontend/src/app`
- `rg -n "include_archived" frontend backend`
