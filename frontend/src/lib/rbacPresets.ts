"use client"

export type RiskLevel = 'low' | 'medium' | 'high'

export type AbilityItem = {
  key: string
  label: string
  permCodes: string[]
  requiresAll?: boolean
  highRiskHint?: boolean
  note?: string
}

export type WorkflowGroup = {
  key: string
  title: string
  description: string
  items: AbilityItem[]
}

export type RoleOverview = {
  roleDisplayName: string
  responsibilities: string[]
  boundaries: string[]
}

export type RolePreset = {
  key: string
  displayName: string
  description: string
  defaultForRoles: string[]
  overview?: RoleOverview
  recommendedMenus: string[]
  recommendedPerms: string[]
  workflowGroups: WorkflowGroup[]
}

export const RBAC_PRESETS: RolePreset[] = [
  {
    key: 'cleaner_inspector',
    displayName: '清洁检查员（推荐）',
    description: '面向现场清洁/检查人员，强调任务执行与反馈，不涉及财务与系统配置。',
    defaultForRoles: ['cleaner_inspector'],
    overview: {
      roleDisplayName: '清洁检查员',
      responsibilities: [
        '查看清洁任务',
        '上传检查照片/视频',
        '提交检查结果与问题反馈',
      ],
      boundaries: [
        '不涉及财务数据与开票操作',
        '不涉及系统配置与权限管理',
      ],
    },
    recommendedMenus: [
      'menu.dashboard',
      'menu.cleaning',
    ],
    recommendedPerms: [
      'cleaning_app.tasks.view.self',
      'cleaning_app.tasks.start',
      'cleaning_app.tasks.finish',
      'cleaning_app.inspect.finish',
      'cleaning_app.issues.report',
      'cleaning_app.media.upload',
      'cleaning_app.sse.subscribe',
      'cleaning_app.push.subscribe',
    ],
    workflowGroups: [
      {
        key: 'cleaning_flow',
        title: '清洁任务流程',
        description: '用于现场执行清洁任务的状态流转与记录。',
        items: [
          { key: 'view_tasks', label: '查看我的清洁任务', permCodes: ['cleaning_app.tasks.view.self'], requiresAll: true },
          { key: 'start_task', label: '开始清洁任务', permCodes: ['cleaning_app.tasks.start'], requiresAll: true },
          { key: 'finish_task', label: '完成清洁任务', permCodes: ['cleaning_app.tasks.finish'], requiresAll: true },
          {
            key: 'set_ready',
            label: '设置房源为可入住（⚠️ 仅管理员/主管）',
            permCodes: ['cleaning_app.ready.set'],
            requiresAll: true,
            highRiskHint: true,
            note: '该能力会影响运营放房与入住安排，建议仅在高级权限中开启。',
          },
        ],
      },
      {
        key: 'inspection_feedback',
        title: '检查与反馈',
        description: '用于上传证据与提交检查结果，推动维修/运营跟进。',
        items: [
          { key: 'upload_media', label: '上传检查照片/视频', permCodes: ['cleaning_app.media.upload'], requiresAll: true },
          { key: 'report_issue', label: '提交问题反馈', permCodes: ['cleaning_app.issues.report'], requiresAll: true },
          { key: 'inspection_complete', label: '提交检查结果', permCodes: ['cleaning_app.inspect.finish'], requiresAll: true },
        ],
      },
      {
        key: 'realtime',
        title: '提醒与实时更新',
        description: '用于接收任务变更提醒与实时状态更新。',
        items: [
          { key: 'subscribe_sse', label: '实时更新（自动刷新）', permCodes: ['cleaning_app.sse.subscribe'], requiresAll: true },
          { key: 'subscribe_push', label: '推送通知订阅', permCodes: ['cleaning_app.push.subscribe'], requiresAll: true },
        ],
      },
    ],
  },
  {
    key: 'cleaning_manager',
    displayName: '清洁管理员（推荐）',
    description: '面向清洁统筹与派单人员，具备全局排班/派单能力。',
    defaultForRoles: ['cleaning_manager'],
    recommendedMenus: [
      'menu.dashboard',
      'menu.cleaning',
    ],
    recommendedPerms: [
      'cleaning.schedule.manage',
      'cleaning.task.assign',
      'cleaning_app.calendar.view.all',
      'cleaning_app.assign',
      'cleaning_app.sse.subscribe',
      'cleaning_app.push.subscribe',
    ],
    workflowGroups: [
      {
        key: 'schedule_assign',
        title: '排班与派单',
        description: '用于创建/调整排班与分配任务，确保任务有人负责。',
        items: [
          { key: 'schedule_manage', label: '管理清洁排班', permCodes: ['cleaning.schedule.manage'], requiresAll: true },
          { key: 'task_assign', label: '后台任务分配', permCodes: ['cleaning.task.assign'], requiresAll: true },
          { key: 'calendar_all', label: '查看全部日历', permCodes: ['cleaning_app.calendar.view.all'], requiresAll: true },
          { key: 'assign_in_app', label: '在 App 中派单/转派', permCodes: ['cleaning_app.assign'], requiresAll: true },
        ],
      },
    ],
  },
  {
    key: 'finance_staff',
    displayName: '财务人员（推荐）',
    description: '面向财务与结算岗位，包含大量高风险权限，需谨慎配置。',
    defaultForRoles: ['finance_staff'],
    recommendedMenus: [
      'menu.dashboard',
      'menu.finance',
      'menu.finance.invoices.visible',
      'menu.landlords',
      'menu.properties',
    ],
    recommendedPerms: [
      'invoice.view',
      'invoice.draft.create',
    ],
    workflowGroups: [
      {
        key: 'invoice_basic',
        title: '发票（基础）',
        description: '用于查询与创建草稿发票，不包含正式开票与作废等高风险动作。',
        items: [
          { key: 'invoice_view', label: '查看发票', permCodes: ['invoice.view'], requiresAll: true },
          { key: 'invoice_draft', label: '创建发票草稿', permCodes: ['invoice.draft.create'], requiresAll: true },
        ],
      },
    ],
  },
]

export function getPresetByRoleName(roleName: string | null | undefined): RolePreset | null {
  const name = String(roleName || '').trim()
  if (!name) return null
  return RBAC_PRESETS.find((p) => p.defaultForRoles.includes(name)) || null
}

export function collectPresetPermissionCodes(preset: RolePreset) {
  const codes = new Set<string>()
  preset.recommendedMenus.forEach((c) => codes.add(c))
  preset.recommendedPerms.forEach((c) => codes.add(c))
  preset.workflowGroups.forEach((g) => g.items.forEach((it) => it.permCodes.forEach((c) => codes.add(c))))
  return Array.from(codes)
}

export function validatePresetCodes(preset: RolePreset, knownPermissionCodes: Set<string>) {
  const allCodes = collectPresetPermissionCodes(preset)
  const missing = allCodes.filter((c) => !knownPermissionCodes.has(c))
  const missingRecommended = [...preset.recommendedMenus, ...preset.recommendedPerms].filter((c) => !knownPermissionCodes.has(c))
  return { missing, missingRecommended }
}

