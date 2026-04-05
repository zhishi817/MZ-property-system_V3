---
name: execution-record
description: Record a confirmed execution plan and its implementation result into the current repository's docs/execution-records.md file. Trigger when the user asks to record a plan, record execution results, capture implementation outcomes, or explicitly mentions execution-record.
---

# Execution Record

Use this skill when the user wants a durable record of an approved plan, the implementation result, or both.

## Responsibilities
- Identify the current task title.
- Summarize the confirmed plan in concise, auditable bullets.
- Summarize the implementation result, validation outcome, open issues, and follow-ups.
- Append or update the repository record file at `docs/execution-records.md`.

## Do Not Use This Skill For
- Deciding whether work should be executed.
- Replacing the normal implementation or testing workflow.
- Maintaining external systems or project-management tools.

## Default Target File
- Use `docs/execution-records.md` in the active repository.
- If the file does not exist, create it.
- If the repository root is unclear, inspect the current workspace before writing.

## Task Title Priority
1. A user-provided explicit task title.
2. The latest approved plan title.
3. A short title inferred from the current conversation.

Keep Chinese task titles in their original wording. Do not translate or shorten them unless the user asked for that.

## Status Values
Use exactly one of these values:
- `planned`
- `implemented`
- `partially implemented`
- `blocked`

## Record Shape
Each task record must include these sections:
- `Date`
- `Task`
- `Status`
- `Confirmed Plan`
- `Implementation Result`
- `Validation`
- `Files / Areas`
- `Open Issues / Follow-ups`

Use short flat bullets under each section when there is content. If a section is not applicable yet, say so explicitly instead of omitting it.

## Update Rules
- If the task does not exist yet, append a new record.
- If the same task already exists for the same date, append an `Update` subsection instead of creating a duplicate top-level record.
- If a prior entry was `planned` and the work is now done, keep the existing task entry and add an update that changes the effective status to `implemented` or `partially implemented`.
- Do not silently overwrite previous validation or risk notes.

## Workflow
1. Confirm the active repository root and ensure `docs/` exists.
2. Open or create `docs/execution-records.md`.
3. Determine the task title using the priority rules above.
4. Extract the user-approved plan and summarize it under `Confirmed Plan`.
5. Extract actual changes and summarize them under `Implementation Result`.
6. Extract verification outcomes under `Validation`, including partial failures.
7. List the most relevant files or subsystems under `Files / Areas`.
8. Record remaining risks, blockers, or follow-ups under `Open Issues / Follow-ups`.
9. Write or update the record.

## Partial Information Handling
- If the user only asked to record the plan, use `Status: planned` and state that implementation has not happened yet.
- If the user asked to add execution results later, append an `Update` subsection under the same task.
- If critical context is missing, explain what is missing and ask the minimum necessary follow-up.

## Style Rules
- Prefer concise, factual wording.
- Preserve exact filenames, route names, and interface names when they matter.
- Record both successful and failed validation outcomes.
- Avoid narrative paragraphs when a short bullet is clearer.

## References
- `references/record-template.md` for the exact Markdown skeleton.
- `references/naming-rules.md` for task-title and update naming rules.
