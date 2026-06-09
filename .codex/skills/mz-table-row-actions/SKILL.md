---
name: mz-table-row-actions
description: Use when creating or updating MZ Property System admin table operation columns, row action buttons, 操作列, CRUD action order, destructive actions, or permission-based action visibility.
---

# MZ Table Row Actions

Keep admin table operation columns consistent with the property list.

## Standard

1. Render actions with `frontend/src/components/TableRowActions.tsx`.
2. Use this order when the actions exist:
   - `详情`
   - `编辑`
   - workflow actions such as `下载`, `审批`, or `作废`
   - destructive action such as `删除` or `归档`
3. Use the default Ant Design button style. Do not use `type="link"`, `type="text"`, or an ellipsis dropdown for standard CRUD actions.
4. Mark destructive actions with `danger: true` and require confirmation before executing them.
5. Hide actions the user cannot perform. Do not replace missing permission with a disabled button.
6. Keep actions on one line and give fixed-right columns enough width for all visible buttons.
7. Preserve business rules: omit unsupported actions and keep the remaining actions in the standard relative order.

## Implementation

```tsx
<TableRowActions
  actions={[
    { key: 'detail', label: '详情', onClick: () => openDetail(row) },
    { key: 'edit', label: '编辑', onClick: () => openEdit(row), hidden: !canWrite },
    { key: 'download', label: '下载', onClick: () => download(row), hidden: !canWrite },
    { key: 'delete', label: '删除', onClick: () => confirmDelete(row), danger: true, hidden: !canDelete },
  ]}
/>
```

## Verification

1. Check every changed `title: '操作'` column.
2. Confirm order, permissions, confirmation behavior, and one-line layout.
3. Run the frontend build.
