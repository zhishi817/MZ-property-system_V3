"use client"

import { ADMIN_NAVIGATION, buildMenuPermissionTree, type MenuPermTreeNode } from '../../lib/adminNavigation'

export const MENU_PERMISSION_TREE = buildMenuPermissionTree(ADMIN_NAVIGATION)

type MenuIndexNode = {
  key: string
  label: string
  perms: string[]
  children: string[]
  parent?: string
  checkable: boolean
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

export const MENU_PERMISSION_INDEX = buildMenuIndex(MENU_PERMISSION_TREE)

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

export function findMenuNode(tree: MenuPermTreeNode[], key: string): MenuPermTreeNode | null {
  const target = String(key || '').trim()
  if (!target) return null
  let found: MenuPermTreeNode | null = null
  function walk(nodes: MenuPermTreeNode[]) {
    nodes.forEach((node) => {
      if (node.key === target) found = node
      if (!found && node.children?.length) walk(node.children)
    })
  }
  walk(tree)
  return found
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
