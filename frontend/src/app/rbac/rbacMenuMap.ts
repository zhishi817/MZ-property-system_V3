"use client"

import { ADMIN_NAVIGATION, buildMenuPermissionTree, type AdminNavNode, type MenuPermTreeNode } from '../../lib/adminNavigation'

export const MENU_PERMISSION_TREE = buildMenuPermissionTree(ADMIN_NAVIGATION)

export type MenuIndexNode = {
  key: string
  label: string
  perms: string[]
  children: string[]
  parent?: string
  checkable: boolean
}

export type MenuMatrixRow = {
  key: string
  label: string
  pathLabels: string[]
  pathText: string
  parentLabel?: string
  depth: number
  perms: string[]
  children: string[]
}

function buildMenuIndex(tree: MenuPermTreeNode[]) {
  const index: Record<string, MenuIndexNode> = {}
  function walk(nodes: MenuPermTreeNode[], parent?: string) {
    nodes.forEach((node) => {
      index[node.key] = {
        key: node.key,
        label: node.label,
        perms: node.perms || [],
        children: (node.children || []).map((child) => child.key),
        parent,
        checkable: !!node.checkable,
      }
      if (node.children?.length) walk(node.children, node.key)
    })
  }
  walk(tree)
  return index
}

function buildMatrixRows(nodes: AdminNavNode[]) {
  const rows: MenuMatrixRow[] = []

  function walk(node: AdminNavNode, stack: string[], depth: number) {
    const nextPath = [...stack, node.label]
    if (node.rbacKey) {
      rows.push({
        key: node.rbacKey,
        label: node.label,
        pathLabels: nextPath,
        pathText: nextPath.join(' / '),
        parentLabel: stack[stack.length - 1],
        depth,
        perms: (node.actionPerms || []).map((code) => String(code || '')).filter(Boolean),
        children: (node.children || []).map((child) => child.rbacKey).filter(Boolean) as string[],
      })
    }
    ;(node.children || []).forEach((child) => walk(child, nextPath, depth + 1))
  }

  nodes.forEach((node) => walk(node, [], 0))
  return rows
}

export const MENU_PERMISSION_INDEX = buildMenuIndex(MENU_PERMISSION_TREE)
export const MENU_PERMISSION_ROWS = buildMatrixRows(ADMIN_NAVIGATION)

export function buildMenuKeySet(tree: MenuPermTreeNode[]) {
  const keys: string[] = []
  function walk(nodes: MenuPermTreeNode[]) {
    nodes.forEach((node) => {
      if (node.checkable) keys.push(node.key)
      if (node.children?.length) walk(node.children)
    })
  }
  walk(tree)
  return new Set(keys)
}

export function buildPermToMenuIndex(tree: MenuPermTreeNode[]) {
  const out: Record<string, Set<string>> = {}
  function walk(nodes: MenuPermTreeNode[]) {
    nodes.forEach((node) => {
      if (node.checkable) {
        ;(node.perms || []).forEach((perm) => {
          const code = String(perm || '').trim()
          if (!code) return
          out[code] = out[code] || new Set<string>()
          out[code].add(node.key)
        })
      }
      if (node.children?.length) walk(node.children)
    })
  }
  walk(tree)
  return out
}

export function findMenuPathLabels(tree: MenuPermTreeNode[], key: string) {
  const target = String(key || '').trim()
  const path: string[] = []
  function walk(nodes: MenuPermTreeNode[], stack: string[]) {
    for (const node of nodes) {
      const next = [...stack, node.label]
      if (node.key === target) {
        path.splice(0, path.length, ...next)
        return true
      }
      if (node.children?.length && walk(node.children, next)) return true
    }
    return false
  }
  walk(tree, [])
  return path
}
