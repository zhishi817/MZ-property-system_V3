# MZ-115 深清派工、审核与照片：范围及验证记录

## Approved scope

- User authorization on 2026-11-12: real personnel assignment; price may remain empty during assignment/execution; administrator review confirms a whole-order total or itemized prices and the existing deduction/payment method; mobile displays before/after photos and submits for review.
- Only the exact `admin` role may review. `rbac.manage` or a generic audit permission is not an equivalent role.
- Personnel settlement integration was explicitly postponed. No payroll records, settlement preview, claims, supplier payment or extra charge rules are part of this change.
- Follow-up owner decision: the mobile completed-feedback form may select the actual cleaner, defaulting to the current submitter only when eligible and allowing substitution for submissions on another person's behalf. The backend must validate the explicit ID and preserve the existing manager-entry role boundary.
- Preview follow-up: the user explicitly broadened deep-cleaning executors to all real user accounts except customer service. A dedicated deep-cleaning rule excludes any normalized `customer_service` role, including mixed-role accounts, while allowing finance and other real users. Shared eligibility for other task types is unchanged; mixed batches retain both checks. Existing assignees are not automatically revoked, and no new inactive-account field or service-account rule is invented. Only admin may still review.
- The edit surface must distinguish the submitting person from the actual executor and show authoritative assignment/review changes without dropping unsaved edits. Status changes remain domain actions, not an unrestricted dropdown. Cancellation, unassignment, rejection/rework and reversal of approval are not newly authorized by this display clarification.
- Submitter-display follow-up: preserve the recorded submitter field as stored. A missing submitter may be displayed from a database-verified creation account, but never from an executor, reviewer, or unverified identifier. Keep that derived display separate from editable/persisted data so an unrelated edit does not save a guessed identity. If neither source is reliable, show `未记录`; do not backfill historical records. The original record submitter, actual executor, and administrator reviewer remain distinct. This does not add reviewer-name UI, change who can submit/review, or redefine completion submission as initial record creation.
- The user explicitly clarified that deep cleaning is unrelated to checkout/check-in cleaning. Its detail view must not borrow turnover titles, times or guest-turnover sections, including when unrelated fields are accidentally present. Shared component/cache changes must be source-scoped; existing ordinary cleaning/inspection/maintenance presentation and unsaved editing behavior stay unchanged. Preview fixtures must be independent deep-cleaning records, not a spread of a normal-cleaning test fixture.
- The user subsequently requested uploading cleaning-before photos from the execution surface as well. Existing report/admin-edit upload entries remain unchanged. The assigned executor may add optional before photos in the deep-cleaning detail or Web completion drawer, then submit them atomically with the required after photos for review. Stored original photos are preserved; additions are append-only with exact-reference deduplication. This does not introduce an immediate-save endpoint, deletion of stored evidence, review-stage executor editing, or new role/capability grants.
- Necessary standalone-deep media correction approved during this follow-up: reading already-associated deep-cleaning evidence must validate the exact real work task, source record and property, then allow the current executor or actual admin review access. Independent deep-cleaning access does not require an unrelated checkout/check-in task. An existing original-source permission must not be lost merely because a valid deep context was added: retain the complete legacy source-task plus feedback authorization, never an unconditional write/manager/finance shortcut. Wrong context and unassociated uploads stay denied; a previous assignment alone grants nothing, while independently valid historical permissions retain their original rules. No public fallback is introduced. Web execution upload reuses the existing authenticated `/mzapp/upload` contract, not the admin-edit upload route.
- Admin review also needs before/after evidence on new unassigned and older pending records that have no real work-task projection. The explicitly approved read-only compatibility path uses the exact deep-cleaning record ID and its already-associated unique image reference, with actual server/database admin validation. It creates no task or data and adds no ordinary-user permission. A supplied wrong work-task ID must never fall back to the record path; independently valid old source authorization remains unchanged.
- Backend, web `/deep-cleaning/records`, mobile deep-cleaning task detail and the existing deep-cleaning feedback completion entry are in scope. Only deep-cleaning ownership/context at existing queue call sites changes; shared authentication behavior, upload transport, object storage and unrelated maintenance workflows are not redesigned.
- Necessary bypass closure subsequently approved: public deep-cleaning share/upload keeps its existing authentication and evidence submission, but cannot determine or overwrite reviewed prices. Public completion is a submission for administrator review, not approval. No public executor directory is added.
- Permitted writes are isolated source/tests/documentation and synthetic local test state. Production database writes, migration execution, external sync, release, deployment and OTA are not authorized.

## Isolation

- Root starts from fetched `origin/Dev` at `d58f39bf05835a3f56672edf72f8cd34baff7643`; Mobile starts at `1ec20d490097fd13798767d74c40851b5da9c85f`.
- Original mixed worktrees remain source evidence only. New detached worktrees hold this one feature.
- Related MZ-113 source is already in Dev. Its released CRL identity and implementation are preserved; MZ-115 is root/mobile `CRL-20261112-001`.
- Tests must clear inherited service configuration and block outbound transport before imports. A database-backed test must prove it is a newly created temporary local instance before any test writes. No production `.env` is loaded.

## Confirmed previous behavior

- The web edit drawer stores a free-text worker name, not a real assigned user. Generic edits can independently change status, price and audit state.
- Generic deep-cleaning completion on mobile optimistically marks a task done, unlike the maintenance pending-review flow.
- Existing accounting uses a completed source record and its payment method to synchronize automatic expenses. Merely adding a review badge does not stop that cascade.
- Current deep-cleaning fees are labor plus consumables; the proposed whole-order amount must not add the same consumables twice. Unknown prices must remain unknown rather than become zero.
- Existing media fields distinguish original (`photo_urls`) and completion (`repair_photo_urls`) photos, but some feedback-created records also contain the original reference in attachments.

## Media incident diagnosis

- Phase: authorized domain-specific repair and local regression, not release or production verification.
- Classification: `PROPERTY_FEEDBACK`; source: `property_deep_cleaning` and its existing work-task projection.
- Business owner and persisted association: source contract inspected; actual production row not queried (`NOT CHECKED` at runtime).
- Storage identity/object: `NOT CHECKED`. A screenshot is not evidence that every stored object is present.
- Authenticated read context and authorization: existing authenticated feedback media path is retained; deployed-role/object checks are `NOT CHECKED`.
- API/domain adapter: source evidence shows the mobile generic completion branch does not preserve a dedicated deep-cleaning pending-review model (`FAIL`, code evidence).
- Renderer: user screenshots show duplicate original-photo/attachment presentation and a cropped wide thumbnail. `DeepCleaningMedia` is deep-cleaning-only and uses a full-width, 140-pixel `cover` image (`FAIL`, screenshot and code evidence).
- Minimal repair: separate before/after rendering, exact-reference display deduplication while retaining stored attachment fields, bounded `contain` thumbnails, and the domain workflow response as the completion authority.
- Dependency classification: domain-specific page/component/adapter. Existing private reader, shared renderer and upload lifecycle are reused, not replaced.
- Legacy contract: retain exact stored references and existing authentication; no public URL fallback, object copy/deletion, historical field rewrite or inferred missing-photo recovery.
- Execution-before additions use an independent before-phase draft namespace, isolated by source/task and owner. Local evidence and uploaded references remain until canonical business association is confirmed; after-photo drafts must not mix with or be cleared by the before phase. The complete request's optional `before_photo_urls` preserves older clients when omitted.
- Completion-draft contract: upload success is not business save; keep durable local evidence through failures and clean only after the server confirms its association. Do not introduce another queue.

## Implementation decisions and stop conditions

- Prices entered in either whole-order mode or itemized mode represent the final whole-order amount, including existing consumables. No automatic second addition and no hourly rate is invented. Existing time/history fields remain compatible.
- New workflow mutations must atomically preserve source state, projected task state, audit/receipt and any authorized automatic expense effects. Duplicate review must not duplicate charges.
- Itemized review details use the existing private `audit_logs` record (`deep_cleaning_review`), not a task event visible to the executor. `total_cost` remains the authoritative whole-order amount. Public task refresh events carry no review prices or actor-specific capabilities, and field-worker workflow responses/receipts omit finance fields.
- Ordinary edits and alternate completion endpoints must not bypass administrator review or recalculate an approved whole-order amount from historical labor fields.
- Preserve historical completed records/expenses. Do not backfill, reinterpret or void them merely because the new workflow exists.
- A legacy completed record with an explicit pending review is displayed as awaiting review without automatically rewriting it. An administrator may explicitly choose its missing real executor and confirm the price in one review transaction; an existing executor cannot be silently replaced, and manually overridden expenses block automatic repricing.
- Legacy in-flight mobile batches may be repaired only through an explicit actual-person selection that preserves uploaded references, completed steps and source IDs. Newly written batches record their owner. Older batches require verified source/owner evidence; a batch with neither owner nor source mapping remains preserved and blocked rather than being guessed or discarded.
- Reuse existing schema only when its intended lifecycle and compatibility are verified. Stop for owner authorization before an application schema migration, new deduction rule, permission-core rewrite or production data change.

## Validation status

Source implementation is complete for the approved scope. Web fixture interaction, the complete frontend/backend gates, guarded temporary PostgreSQL and Mobile check:ci have passed. Final fast-gate and complete-snapshot independent review are recorded separately in the paired CRLs; none of those checks implies release or production acceptance.

An unknown-owner historical batch without a server source mapping remains blocked for manual identity verification. The legacy project modal has no caller in the current source; its defensive completion handler explicitly refuses to reinterpret a single project's completion as whole-order completion. Old versions must use the matching backend/mobile release pair, not rely on the retired non-atomic completion route.

Physical iOS/Android, authenticated deployed media, production database/object state, deployment and OTA have not been verified.
