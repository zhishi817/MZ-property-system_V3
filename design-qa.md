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

---

# Design QA — 费用结算异议弹窗

- Source visual truth: `/Users/zhishi/.codex/generated_images/01a08935-889d-7353-a5b7-d510e6683deb/exec-d466ffb5-c054-4663-a698-71a1d9d214f4.png`
- Implementation screenshot: `/tmp/mz-settlement-dispute-modal-implementation.png`
- Browser viewport: 1920 x 900 CSS px, device scale factor 1
- Source pixels: 1197 x 1314
- Implementation modal pixels: 820 x 793
- Density normalization: not applied; the implementation was captured at its exact CSS modal size.
- State: `cleaner-1`, 2026-08-17 to 2026-08-23, disputed, approved $35 supplement already included, automatic-summary option selected.

## Full-view comparison evidence

The source visual and the browser-rendered implementation were both opened and inspected. A required single side-by-side comparison artifact could not be produced because the controlled browser rejected the local data-URL comparison page under its URL security policy. The blocked navigation was not bypassed or retried through another browser surface.

## Focused region comparison evidence

Not completed. A focused comparison would depend on the same blocked combined comparison input. Separate inspection confirmed that the implementation renders the summary, dispute reason, claim amount, proof thumbnail, included status, automatic/exception decision states, final amount, and footer actions, but separate views do not satisfy the Product Design comparison gate.

## Browser interaction checks

- Opened `/finance/settlements` in the fixed Preview with the existing admin session.
- Selected settlement week 2026-08-17 to 2026-08-23 and opened the disputed `cleaner-1` record.
- Confirmed the default automatic-summary state hides the manual total input.
- Confirmed selecting `特殊调整总额` reveals the AUD total input and switching back hides it again.
- Confirmed `查看证明` opens the authenticated proof-image viewer.
- Did not click `确认并重新发起`, so no settlement, notification, PDF, or database write was triggered.
- Console inspection found no current-task runtime exception after rendering. Historical hot-reload logs included a transient missing-CSS-module error from the interval between editing the import and creating the stylesheet; the later production build resolved the module successfully.

## Required fidelity surfaces

- Fonts and typography: implementation uses the existing Ant Design/system font stack and hierarchy; formal pixel comparison blocked.
- Spacing and layout rhythm: visible implementation follows the selected summary, claim table, finance decision, and final-total hierarchy without clipping at the tested desktop viewport; formal pixel comparison blocked.
- Colors and visual tokens: implementation uses existing MZ `#0052D9` primary and Ant Design semantic red/green/blue surfaces; formal sampled comparison blocked.
- Image quality and asset fidelity: the authenticated waterfall proof image renders at 112 x 76 with cover cropping and opens in the existing Ant Design preview; formal crop comparison blocked.
- Copy and content: visible amounts, dates, person, reason, status, and actions match the selected workflow state.

## Findings

- Verification blocker: the required combined source/implementation comparison input is unavailable under the browser URL security policy. No visual mismatch is asserted from separate screenshots alone.

## Comparison history

- Pass 1: source and implementation captured separately; combined comparison blocked before a valid P0/P1/P2 assessment could be completed.

## Implementation checklist

- Obtain an allowed side-by-side comparison surface or have the user visually approve the fixed Preview rendering.
- Repeat the same-state desktop capture and focused claim/action-region comparison.
- Change the final result to `passed` only if no actionable P0/P1/P2 differences remain.

final result: blocked

---

# Design QA — 工作量反馈确认计入弹窗（方案 1）

- **Status:** passed
- **Route:** `/finance/settlements` → `工作量反馈` → `确认计入`
- **Reference:** `/Users/zhishi/.codex/generated_images/01a08935-889d-7353-a5b7-d510e6683deb/exec-ad82a35f-2585-4429-99bd-a31d12f67e57.png`
- **Implementation capture:** `/private/tmp/mz-confirm-workload-option1-final.jpg`
- **Focused reference crop:** `/private/tmp/mz-confirm-workload-option1-reference-crop.png`
- **Focused implementation crop:** `/private/tmp/mz-confirm-workload-option1-implementation-crop.jpg`
- **Reference pixels:** 1487 × 1058; focused modal region 714 × 904.
- **Implementation pixels:** 1920 × 958; focused modal region 720 × 880.
- **State:** `cleaner-1`, 14/09/2026, 仓管工时, 17:10–18:00, 50 分钟, `$35.00/小时`, 已含 GST。

## Full-view comparison evidence

- The reference and implementation were inspected together in one visual comparison input after the final CSS pass.
- The implementation retains the existing MZ navigation and Ant Design chrome while matching the selected modal hierarchy: submitted work, explanation and proof, one applicable review input, automatic calculation, GST breakdown, optional note, and amount-bearing confirmation action.
- The modal was moved to a 24px top offset so the full footer remains visible in the available 958px-high browser viewport.

## Focused region comparison evidence

- Modal widths are effectively aligned at 714px reference and 720px implementation.
- Typography, spacing rhythm, blue calculation surface, large total, two-row tax breakdown, proof-image crop and footer actions remain visually consistent with the selected direction.
- The implementation intentionally keeps the generic label `提交工作量` instead of the reference-only `提交工时`, because the same component also supports amount, quantity and day-based feedback.

## Browser interaction checks

- Opened the current week `2026-09-14 至 2026-09-20` in the existing authenticated fixed Preview session.
- Opened the submitted `cleaner-1` warehouse-hour record without clicking the final write action.
- Confirmed the backend estimate renders `$35.00/小时 × 50分钟 ÷ 60`, total `$29.17`, tax-before amount `$26.52`, and included GST `$2.65`.
- Changed the review duration to 60 minutes and confirmed the read-only estimate updates to `$35.00`, tax-before `$31.82`, GST `$3.18`; restored 50 minutes and `$29.17`.
- A transient Next.js stylesheet hot-reload `removeChild` overlay occurred while the CSS file was being edited. A full navigation reload cleared it; the clean final state rendered with no runtime overlay.
- Did not click `确认并计入`, so no claim, weekly settlement, notification, PDF, company expense or database state was changed.

## Findings

- P0: none.
- P1: none.
- P2: none after moving the modal upward to prevent footer clipping.
- P3: the real application has a wider navigation shell than the concept image; this does not affect the modal workflow or content hierarchy.

## Evidence boundary

- Validation used the fixed Preview frontend and development backend/database in read-only UI interactions. It did not commit, push, deploy, call production, or execute the final approval write.

final result: passed
