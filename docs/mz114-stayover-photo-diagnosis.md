# MZ-114: Stayover completion photos

## Approved scope and evidence

- Phase 3, single incident repair after the user's explicit instruction to start MZ-114.
- Classification: TASK_OPERATIONAL. Surface: active CleaningSelfCompleteScreen, completion photo save and formal self-complete, assigned cleaning participant.
- Root base: cb0425fdeae33baa790b7d9d381e8153719770fa. Mobile base: c5b87b5b38e602e5d852971a6455a828c90ad170. Diagnosed production source: 67610f6c238ae7459ca24e59c4fd6e466b408ba0.
- Allowed writes: isolated source/tests/docs and fresh, synthetic, verified loopback PostgreSQL only. Production database, object storage, authentication, notifications, deployment and OTA are excluded.
- The user clarified that stayover drains require at least one photo and allow multiple bathrooms/photos. The old maximum of one is an implementation error, not an approved business rule.

## Media Incident Diagnosis

- Business owner: PASS for a same-day stayover candidate consistent with the screenshot timestamps; screenshots contain no room/task ID, so record-to-screenshot identity is high-confidence, not directly proved.
- Persisted association: FAIL at the reported pre-save preview boundary. Object uploads preceded the first successful completion-photo association.
- Storage identity/object: NOT CHECKED. No object retrieval or recovery is necessary for the diagnosed pre-association failure.
- Authenticated context/authorization: NOT REACHED for unassociated objects. The proxy correctly rejects unrecorded media; its recorded-uploader authorization is unchanged.
- API response/domain adapter: FAIL. The draft renderer preferred remote_url immediately after object upload even when completion_business_saved was false.
- Renderer/viewer: correctly displayed the proxy's terminal 403; the source selection, not the privacy check, was wrong.
- Source evidence confidence: high. Exact phone HTTP/OTA and real-device rendering were not captured.

Two additional boundaries fail independently:

1. The server accepts only one shower_drain photo while the stayover page says at least one and permits additional captures. Canonical locked task_type must select the stayover exception; the client cannot claim its own task type.
2. Saving completion photos emits a complete_cleaning audit without changing task status. The subsequent real completion treats it as terminal and returns work_record_read_only. New saves need a nonterminal record_completion_photos audit. Legacy compatibility must match action, exact route, exact step, and unchanged before/after status; it must not ignore an unknown or genuinely transitioning completion audit.

## Architecture and compatibility boundary

- Existing lifecycle: cleaningConsumablesSubmitQueue, stable media_id, /cleaning-app/upload, task completion-photos business association, authenticated /cleaning-app/media/image, CleaningMediaImage and CleaningMediaPreview.
- Mobile owns local draft/preview state; server owns task type, persisted association, authorization and final records. No second upload queue or raw private URL fallback is introduced.
- Until business save is confirmed, preserve durable local preview and remote upload identity for business-only retry. An exact reference independently returned by the current successful same-task, same-area server read is already associated and can retain authenticated remote preview. A failed read never grants that authority. Missing unassociated local preview is explicit, not permission bypass. Saved/historical remote references retain normal proxy behavior.
- This is a domain-specific repair. Shared renderers, private-media proxy, storage rules and Viewer behavior are unchanged. The role-mutation helper is shared by cleaning/key/restock/inspection/video operations; only the complete_cleaning branch receives the narrow legacy photo-save exception. Existing transition and authority regressions remain required for all callers.
- Stayover shower_drain has a minimum of one at formal completion and no new arbitrary per-area maximum. Other task types retain their previous limit. All other area maxima and the single-frame remote-control rule remain unchanged pending separate business review.
- Existing one/multiple-photo arrays and known legacy photo-save audits are readable without migration or rewriting. No production audit repair or object recovery is performed.

## Validation boundaries

- Default contract/transition tests are synthetic and network-blocked.
- The real PostgreSQL test requires a fresh /tmp data directory, numeric loopback, nondefault random port, dedicated mz114 database, explicit opt-in flags and server identity verification before fixture writes. It runs actual route handlers and actual business SQL, with external side effects stubbed.
- Required cases: multiple drains, final minimum, save then complete, exact legacy recovery, genuine/unknown terminal protection, unauthorized actor, idempotent replay/conflict, transaction rollback, and unchanged other limits.
- Authentication middleware is stubbed in the route integration fixture; it exercises actual participant authorization SQL, not an end-to-end sign-in stack.
- An initial Mobile aggregate encountered a preexisting unmocked Contacts API path; its external outcome is unknown and its aggregate count is not treated as isolated validation. Final local validation passed with reviewed test transport guards, explicit fixtures, synthetic origins, cleared environment and temporary HOME. This is not an OS sandbox guarantee. The final Mobile aggregate passed 88 suites / 907 tests with exit 0, no unexpected blocked calls or open-handle warning.
- Independent review, full backend and paired Mobile gates are recorded in the CRLs. Real camera/gallery, simulator/device, weak-network hardware behavior, production APIs, deployed backend and OTA are separate stages and are not implied by these tests.

## Delivery

Paired units: root/CRL-20261110-004 and mobile/CRL-20261110-001. No commit, push, PR, merge, production deployment, OTA, or real-device verification is authorized by this implementation task.
