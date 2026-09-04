# Design QA — Annual Report Split Workspace

- **Status:** passed
- **Route:** `/finance/performance/annual`
- **Reference:** `/Users/zhishi/.codex/generated_images/01a06513-59e3-70b0-8404-2d8ff9d5b7ab/exec-be2b30e4-f647-4649-b222-f87039029b38.png`
- **Implementation capture:** `/private/tmp/mz-annual-report-overview-final2.png`
- **Combined comparison:** `/private/tmp/mz-annual-report-design-comparison.png`
- **Comparison state:** FY2026, property `8831702S`, incomplete report, overview tab, local mock data only.

## Visual assessment

- P0: none.
- P1: none.
- P2: none.
- P3: the implementation keeps the repository's existing wider navigation and Ant Design controls, so the content density differs slightly from the concept image. The intended hierarchy is preserved: filters, selectable property list, persistent report workspace, status metrics, month completeness and explicit actions.
- Responsive result: the two-column workspace remains usable at the available 1280px validation viewport; status and row actions remain visible, while inner report sections collapse before horizontal clipping.

## Interaction assessment

- `详情` selects the row and opens the overview without automatically rendering the full draft beneath the list.
- `编辑` opens the standard right-side drawer.
- Manual months expose amount, completeness and note controls; system months are explicitly read-only.
- Unsaved changes trigger a discard confirmation before closing or changing context.
- Report preview is rendered only after the `预览` action or `报告预览` tab is selected.
- Browser console check after a fresh load returned no errors or warnings introduced by this page.

## Evidence boundary

- Validation used an isolated local frontend and a temporary local mock API. It did not call production APIs, write business data, deploy, commit or push.
