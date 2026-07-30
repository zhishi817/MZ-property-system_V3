---
name: mz-mobile-button-rules
description: Enforce the MZ cleaning mobile app button contract when adding, reviewing, or optimizing React Native/Expo screens and shared UI components. Use for any mobile button, Pressable action, icon action, chip, compact control, loading/disabled action, bottom action row, or touch-target audit in mz-cleaning-app-frontend.
---

# MZ Mobile Button Rules

## Overview

Apply one semantic button system across the MZ mobile app without changing business behavior. Classify controls before editing, use shared tokens/primitives, preserve accessible touch targets, and verify text, loading, platform, and action-state behavior.

## Scope and non-goals

Work only in `mz-cleaning-app-frontend` for this contract. Do not change backend APIs, `available_actions`, permissions, navigation, task transitions, submission semantics, inputs, cards, avatars, media dimensions, or unrelated layout polish.

Keep existing concurrent worktree changes. Inspect `git status` and relevant diffs before editing; never reset, clean, or broad-stage files.

## Contract

Use the shared `layoutTokens.button` contract in `src/lib/theme.ts`:

```ts
button: {
  height: 44,
  compactHeight: 36,
  iconVisualSize: 40,
  iconTouchSize: 44,
  horizontalPadding: 16,
  radius: 12,
  textLineHeight: 20,
  gap: 8,
  rowGap: 12,
}
```

Rules:

- Standard labeled actions use `minHeight: layoutTokens.button.height` and `paddingVertical: 0`; do not hard-code ordinary button heights.
- Use `height` only when the control is explicitly a fixed-size non-button element or a documented visual exception.
- Keep input dimensions in a separate input token; never bulk-change input heights with button heights.
- Compact/chip controls may use 36pt visual height, but their actual touch target must remain at least 44pt.
- Icon controls use a 44×44 outer touch frame. A 40pt visual frame or a 20–24pt icon may sit inside it. `hitSlop` is supplemental, not a substitute for the target.
- Floating image delete/close controls also need a 44×44 touch frame even when the visible glyph is smaller.
- Use equal-width button rows with `gap: layoutTokens.button.rowGap`, `flex: 1`, and `minWidth: 0`. Stack controls when long labels or narrow screens would overflow.
- Keep hierarchy in tone, border, and state styling, not arbitrary heights.

## Text, loading, and state rules

- Preserve font scaling and avoid unconditional `numberOfLines={1}` or ellipsis that hides a layout failure. Keep the existing app font scaling policy unless a product accessibility decision explicitly changes it.
- Prefer concise labels, `minHeight`, and layout growth over shrinking text or clipping it. Test Chinese, English, numbers, bold text, and enlarged system font.
- Loading must preserve button height and width, keep the original label in layout or reserve equivalent width, center the spinner, and disable repeat presses.
- Disabled and destructive states must be distinguishable by more than opacity alone. Preserve any server-provided disabled reason and accessibility state.
- Do not infer or reimplement permission/action rules in the button layer. Render the server/client action model as supplied.

## Required workflow

1. Inspect the target screen and shared components. Classify each control as `standard`, `compact`, `icon`, `chip`, `card/row`, `input`, or `non-button` before changing dimensions.
2. Record current size, target token, reason for exceptions, and whether the control has loading, disabled, permission, navigation, or submit behavior.
3. Reuse `AppButton` for labeled actions. Extend it when a needed variant is missing; do not create page-local copies of the shared contract.
4. Use the shared icon-button primitive for close, back, delete, call, password-toggle, and media-overlay actions. If it does not exist, add it beside `AppButton` as part of the same UI system.
5. Migrate page groups without changing handlers, payloads, action lists, or navigation decisions.
6. Run the button audit script and inspect every reported exception. Never fix an audit by replacing numbers globally.
7. Run mobile typecheck, lint, Jest, and relevant focused tests. Record real-device/platform checks separately; do not claim them when unrun.

## Classification checklist

- `standard`: save, submit, confirm, complete, upload, delete, retry, continue, task action.
- `compact`: visually secondary inline actions that still need a 44pt touch target.
- `icon`: close, back, call, eye, remove, refresh, or media-overlay action with an accessibility label.
- `chip`: filter, status, mode, or selection control; keep compact visuals and accessible touch bounds.
- `card/row`: pressable content container whose height is driven by content; do not force button height.
- `input`: text/date/search/select field; use input tokens and multiline rules.
- `non-button`: avatar, badge, thumbnail, icon decoration, divider, or layout container.

## Validation commands

From `mz-cleaning-app-frontend` run as applicable:

```bash
npm run typecheck
npm run lint
npm run check:buttons
npm test -- --runInBand
npm run check:ci
python3 ../.codex/skills/mz-mobile-button-rules/scripts/audit_button_contract.py --strict
```

Also inspect iOS and Android at narrow and wide phone widths, Chinese and long English labels, font scales 1.0 and the app maximum, loading, disabled, destructive, side-by-side, and media-overlay states. Treat device/EAS/native checks as not run unless actually executed.

## Regression and release safeguards

For visual-only button work, use component tests, the static audit, and the shared change ledger; do not add a business Feature Regression entry unless the user explicitly requests a permanent registry rule. Confirm that `available_actions`, permissions, navigation, API payloads, and submission behavior are unchanged.

After any repository mutation, update `docs/change-release-ledger.md` with exact files, behavior, validation, risks, rollback, dependencies, and Git state, then run:

```bash
python3 scripts/audit_change_release_ledger.py
```

Before staging, committing, pushing, or deploying, use the repository's independent Codex release review process. Never push without explicit authorization.
