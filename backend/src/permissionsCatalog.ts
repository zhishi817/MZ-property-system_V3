export type RiskLevel = 'low' | 'medium' | 'high'

export type PermissionMeta = {
  code: string
  displayName: string
  riskLevel: RiskLevel
  purpose: string
  scenarios: string[]
  denyImpact: string[]
  privacyRisk: string[]
}

const resourceNames: Record<string, string> = {
  properties: '房源',
  landlords: '房东',
  orders: '订单',
  order: '订单',
  cleaning_tasks: '清洁任务',
  finance_transactions: '财务交易',
  company_expenses: '公司支出',
  company_incomes: '公司收入',
  property_expenses: '房源支出',
  property_incomes: '房源收入',
  recurring_payments: '固定支出',
  cms_pages: 'CMS 页面',
  payouts: '房东结算',
  company_payouts: '公司结算',
  users: '系统用户',
  order_import_staging: '订单导入暂存',
  property_maintenance: '维修记录',
  property_deep_cleaning: '深度清洁',
  repair_orders: '报修工单',
}

const moduleNames: Record<string, string> = {
  dashboard: '仪表盘',
  landlords: '房东管理',
  properties: '房源管理',
  keys: '钥匙管理',
  inventory: '库存管理',
  finance: '财务管理',
  cleaning: '清洁管理',
  rbac: '角色权限',
  cms: 'CMS',
  onboarding: 'Onboarding',
}

function capFirst(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

function makeMeta(base: Omit<PermissionMeta, 'code'> & { code: string }): PermissionMeta {
  const meta: PermissionMeta = {
    code: base.code,
    displayName: base.displayName,
    riskLevel: base.riskLevel,
    purpose: base.purpose,
    scenarios: base.scenarios,
    denyImpact: base.denyImpact,
    privacyRisk: base.privacyRisk,
  }
  meta.scenarios = Array.isArray(meta.scenarios) ? meta.scenarios.filter(Boolean) : []
  meta.denyImpact = Array.isArray(meta.denyImpact) ? meta.denyImpact.filter(Boolean) : []
  meta.privacyRisk = Array.isArray(meta.privacyRisk) ? meta.privacyRisk.filter(Boolean) : []
  return meta
}

function resourceActionMeta(code: string): PermissionMeta | null {
  const m = code.match(/^([a-z0-9_]+)\.(view|write|delete|archive)$/i)
  if (!m) return null
  const resource = String(m[1])
  const action = String(m[2]).toLowerCase()
  const resName = resourceNames[resource] || capFirst(resource.replace(/_/g, ' '))
  const actionName: Record<string, string> = { view: '查看', write: '编辑', delete: '删除', archive: '归档/反归档' }
  const displayName = `${resName}：${actionName[action] || action}`
  const riskLevel: RiskLevel =
    action === 'view' ? 'low' :
      action === 'write' ? 'medium' :
        action === 'archive' ? 'medium' : 'high'
  const purposeMap: Record<string, string> = {
    view: `允许读取${resName}数据（列表/详情/导出等读取型操作）。`,
    write: `允许创建或修改${resName}数据（新增、编辑、状态变更等写入型操作）。`,
    archive: `允许将${resName}标记为归档或恢复（通常影响业务可见性与后续流程）。`,
    delete: `允许永久删除${resName}数据（不可逆或难以恢复）。`,
  }
  return makeMeta({
    code,
    displayName,
    riskLevel,
    purpose: purposeMap[action] || `允许对${resName}执行 ${action} 操作。`,
    scenarios: [
      `需要查看${resName}列表、详情、报表或对账信息`,
      action !== 'view' ? `需要维护${resName}的资料与业务状态` : '',
      action === 'delete' ? `仅在数据确认为错误录入且允许清理时使用` : '',
    ].filter(Boolean),
    denyImpact: [
      action === 'view' ? `无法查看${resName}数据，相关页面可能空白或报错` : '',
      action === 'write' ? `无法新增/编辑${resName}，相关操作按钮会失败或被隐藏` : '',
      action === 'archive' ? `无法归档/恢复${resName}，影响数据治理与流程收口` : '',
      action === 'delete' ? `无法删除${resName}，错误数据可能需要管理员处理` : '',
    ].filter(Boolean),
    privacyRisk: [
      action !== 'view' ? `写入/删除可能造成业务数据错误、财务对账偏差或流程中断` : `可能暴露${resName}中的个人信息、联系方式、地址等敏感字段（若存在）`,
      action === 'delete' ? `误删通常不可逆，可能触发合规与审计问题` : '',
    ].filter(Boolean),
  })
}

function menuMeta(code: string): PermissionMeta | null {
  if (!code.startsWith('menu.')) return null
  const isVisible = code.endsWith('.visible')
  const name = code.replace(/^menu\./, '').replace(/\.visible$/, '')
  const parts = name.split('.')
  const moduleKey = parts[0]
  const moduleName = moduleNames[moduleKey] || capFirst(moduleKey)
  const displayName = isVisible
    ? `${moduleName} · ${parts.slice(1).join(' / ') || '入口'}（可见）`
    : `${moduleName}（菜单）`
  return makeMeta({
    code,
    displayName,
    riskLevel: 'low',
    purpose: '仅控制前端菜单与入口的可见性，不直接授予数据读写能力。',
    scenarios: [
      '为不同岗位裁剪菜单入口，降低误操作与学习成本',
      '与资源权限配合使用：先展示入口，再决定是否授予数据操作权限',
    ],
    denyImpact: [
      '菜单入口不可见，用户可能无法从导航进入对应模块（仍可能通过直达链接访问，取决于后端权限控制）',
    ],
    privacyRisk: [
      '本权限本身不涉及数据读取，但错误配置可能导致用户误以为“看不到就没有权限”，建议同时检查后端资源权限',
    ],
  })
}

const fixed: Record<string, Omit<PermissionMeta, 'code'>> = {
  'rbac.manage': {
    displayName: '角色权限：管理（高危）',
    riskLevel: 'high',
    purpose: '允许创建/调整角色权限、管理系统用户，是系统的最高影响面权限之一。',
    scenarios: [
      '配置岗位权限矩阵、上线新功能时调整授权范围',
      '新增/删除系统用户、分配角色',
    ],
    denyImpact: [
      '无法进入权限配置与系统用户管理页面',
      '无法完成岗位授权调整，影响团队协作与上线效率',
    ],
    privacyRisk: [
      '可间接获得/授予对所有业务数据的访问与修改能力',
      '错误授权可能造成大范围数据泄露或误操作',
    ],
  },
  'users.password.reset': {
    displayName: '系统用户：重置密码（高危）',
    riskLevel: 'high',
    purpose: '允许为任意系统用户设置新密码，并撤销其现有会话（强制下线）。',
    scenarios: [
      '用户忘记密码、账号被疑似盗用需要快速止损',
      '人员交接或合规要求需要强制更换密码',
    ],
    denyImpact: [
      '无法协助用户恢复账号访问，只能由其他管理员处理',
    ],
    privacyRisk: [
      '若流程不规范，可能导致越权接管账号；需结合审批/审计与最小授权原则',
    ],
  },
  'order.confirm_payment': {
    displayName: '订单：确认收款（高危）',
    riskLevel: 'high',
    purpose: '允许将订单标记为已收款/已支付，影响财务口径与结算流程。',
    scenarios: [
      '财务对账完成后确认收款状态',
      '纠错：修正错误的收款标记（需谨慎）',
    ],
    denyImpact: [
      '无法完成订单收款确认，影响结算与对账推进',
    ],
    privacyRisk: [
      '误操作会造成财务数据偏差与对账风险',
    ],
  },
  'order.deduction.manage': {
    displayName: '订单：内部扣款管理（高危）',
    riskLevel: 'high',
    purpose: '允许新增/修改订单内部扣款项，直接影响结算金额与财务报表。',
    scenarios: [
      '录入赔偿、额外费用、纠错扣款等',
    ],
    denyImpact: [
      '无法维护扣款项，相关金额调整需通过其他流程处理',
    ],
    privacyRisk: [
      '误录入会导致对账偏差、结算纠纷与审计风险',
    ],
  },
  'finance.payout': {
    displayName: '财务：结算/打款（高危）',
    riskLevel: 'high',
    purpose: '允许发起或确认结算相关操作，可能影响资金流转。',
    scenarios: [
      '生成结算单、确认打款状态、复核结算周期',
    ],
    denyImpact: [
      '无法推进结算流程，可能导致延期打款',
    ],
    privacyRisk: [
      '涉及资金与账户信息，错误授权/误操作风险高',
    ],
  },
  'finance.tx.write': {
    displayName: '财务：交易录入/编辑（中高）',
    riskLevel: 'high',
    purpose: '允许录入与修改财务交易数据，影响报表与对账结果。',
    scenarios: [
      '录入支出/收入、调整分类、补充发票信息等',
    ],
    denyImpact: [
      '无法维护财务交易，报表与对账无法闭环',
    ],
    privacyRisk: [
      '涉及金额、供应商信息、发票等敏感数据，需控制范围',
    ],
  },
  'invoice.view': {
    displayName: '发票中心：查看（低）',
    riskLevel: 'low',
    purpose: '允许查看 Tax Invoice 列表、详情、PDF 与发送/付款状态。',
    scenarios: [
      '运营/财务查看开票记录与对账',
      '查询单号、下载 PDF、追踪发送与收款',
    ],
    denyImpact: [
      '无法进入发票中心或查看发票详情',
    ],
    privacyRisk: [
      '可能包含客户姓名/地址/邮箱与金额信息，需按岗位控制',
    ],
  },
  'invoice.draft.create': {
    displayName: '发票中心：创建草稿（中）',
    riskLevel: 'medium',
    purpose: '允许从业务来源生成或手工创建 draft 发票，用于后续审核与开票。',
    scenarios: [
      'Ops 从工单/深清/费用来源批量生成草稿',
      '补录发票草稿，等待财务确认',
    ],
    denyImpact: [
      '无法创建草稿发票，需由财务或管理员代办',
    ],
    privacyRisk: [
      '错误录入可能导致后续开票金额或对象错误',
    ],
  },
  'invoice.issue': {
    displayName: '发票中心：开票/出号（高危）',
    riskLevel: 'high',
    purpose: '允许将发票从 draft 变更为 issued 并分配编号，影响财务口径与对外凭证。',
    scenarios: [
      '财务审核通过后正式开票并生成编号',
    ],
    denyImpact: [
      '无法出号与正式开票，流程无法闭环',
    ],
    privacyRisk: [
      '误开票会造成合规与对账风险，需严格授权与审计',
    ],
  },
  'invoice.send': {
    displayName: '发票中心：发送（中高）',
    riskLevel: 'high',
    purpose: '允许标记或执行发票发送动作，影响客户通知与收款节奏。',
    scenarios: [
      '发送发票 PDF 给客户/房东',
      '补记发送状态与收件人',
    ],
    denyImpact: [
      '无法发送或记录发送状态，追踪困难',
    ],
    privacyRisk: [
      '涉及对外通信与客户信息，需控制范围并留痕',
    ],
  },
  'invoice.void': {
    displayName: '发票中心：作废（高危）',
    riskLevel: 'high',
    purpose: '允许作废已开票的发票，影响财务口径与对外凭证有效性。',
    scenarios: [
      '开票对象/金额错误需要作废并重新开票（需原因）',
    ],
    denyImpact: [
      '无法作废错误发票，可能导致对账与合规问题',
    ],
    privacyRisk: [
      '误作废会造成财务混乱与纠纷，需严格控制与审计',
    ],
  },
  'invoice.payment.record': {
    displayName: '发票中心：记录收款（高危）',
    riskLevel: 'high',
    purpose: '允许记录发票收款金额与状态，影响应收与对账结果。',
    scenarios: [
      '对账完成后录入收款',
      '记录部分付款与结清',
    ],
    denyImpact: [
      '无法维护收款状态，应收与报表不准确',
    ],
    privacyRisk: [
      '误录入会造成应收口径偏差，需配合审计',
    ],
  },
  'invoice.company.manage': {
    displayName: '发票中心：开票主体管理（高危）',
    riskLevel: 'high',
    purpose: '允许维护开票主体的 ABN/地址/Logo/银行信息，直接影响对外发票内容。',
    scenarios: [
      '新增/停用开票主体（不同 ABN）',
      '更新公司地址、Logo 或收款账号信息',
    ],
    denyImpact: [
      '无法维护开票主体信息，可能导致发票信息过期',
    ],
    privacyRisk: [
      '包含银行账户等敏感信息，需最小授权',
    ],
  },
  'landlord.manage': {
    displayName: '房东：资料管理（中）',
    riskLevel: 'medium',
    purpose: '允许新增/修改房东资料及相关结算信息。',
    scenarios: [
      '新增房东、更新联系方式、维护结算账号与比例信息',
    ],
    denyImpact: [
      '无法维护房东资料，影响合同、对账与打款',
    ],
    privacyRisk: [
      '包含联系方式与账户信息等敏感字段，需最小授权',
    ],
  },
  'keyset.manage': {
    displayName: '钥匙：管理（中高）',
    riskLevel: 'high',
    purpose: '允许管理钥匙/门禁等资产信息，影响现场交付与安全。',
    scenarios: [
      '维护钥匙编号、状态、替换记录等',
    ],
    denyImpact: [
      '无法维护钥匙信息，可能影响现场作业安排',
    ],
    privacyRisk: [
      '可能涉及门禁信息，错误授权存在安全风险',
    ],
  },
  'key.flow': {
    displayName: '钥匙：流转记录（中）',
    riskLevel: 'medium',
    purpose: '允许记录与查看钥匙借还、遗失、替换等流转信息。',
    scenarios: [
      '交接追踪、异常定位、责任追溯',
    ],
    denyImpact: [
      '无法记录/追踪钥匙流转，影响审计与现场管理',
    ],
    privacyRisk: [
      '可能包含现场人员信息与时间地点，需控制访问范围',
    ],
  },
  'cleaning.view': {
    displayName: '清洁：查看（低）',
    riskLevel: 'low',
    purpose: '允许查看清洁安排与任务信息。',
    scenarios: [
      '查看排班、任务状态、跟进执行',
    ],
    denyImpact: [
      '无法查看清洁相关页面与任务数据',
    ],
    privacyRisk: [
      '可能包含住客/地址信息（视页面字段而定），建议按岗位控制',
    ],
  },
  'cleaning.schedule.manage': {
    displayName: '清洁：排班管理（中）',
    riskLevel: 'medium',
    purpose: '允许创建与调整清洁排班，影响现场执行计划。',
    scenarios: [
      '安排清洁人员、调整时间、处理临时变更',
    ],
    denyImpact: [
      '无法排班与调整，现场执行可能延误',
    ],
    privacyRisk: [
      '涉及人员安排与房源地址等信息，需控制范围',
    ],
  },
  'cleaning.task.assign': {
    displayName: '清洁：任务分配（中）',
    riskLevel: 'medium',
    purpose: '允许将清洁任务分配给人员/团队，影响执行责任。',
    scenarios: [
      '任务派单、调整负责人、补位与转派',
    ],
    denyImpact: [
      '无法派单，任务可能无人处理',
    ],
    privacyRisk: [
      '包含人员信息与任务细节，需控制范围',
    ],
  },
  'order.create': {
    displayName: '订单：创建（中）',
    riskLevel: 'medium',
    purpose: '允许创建订单记录，可能影响排班与对账。',
    scenarios: [
      '手工补录订单、测试或数据修复（需审批）',
    ],
    denyImpact: [
      '无法新增订单，需依赖自动同步或管理员处理',
    ],
    privacyRisk: [
      '订单可能包含住客信息与金额，需控制范围',
    ],
  },
  'order.write': {
    displayName: '订单：编辑（中）',
    riskLevel: 'medium',
    purpose: '允许修改订单字段（时间、状态、备注等），影响业务流程。',
    scenarios: [
      '纠错订单信息、补充备注、调整状态',
    ],
    denyImpact: [
      '无法编辑订单，纠错与跟进效率下降',
    ],
    privacyRisk: [
      '误修改可能导致排班错误、结算偏差',
    ],
  },
  'order.view': {
    displayName: '订单：查看（低）',
    riskLevel: 'low',
    purpose: '允许查看订单信息。',
    scenarios: [
      '客服跟进、运营查看入住退房安排、对账核对',
    ],
    denyImpact: [
      '无法查看订单模块内容',
    ],
    privacyRisk: [
      '订单可能包含住客姓名/电话/行程等信息，需控制范围',
    ],
  },
  'order.sync': {
    displayName: '订单：同步（中高）',
    riskLevel: 'high',
    purpose: '允许触发订单同步或对接动作，可能产生批量数据变更。',
    scenarios: [
      '同步平台订单、补拉数据、处理同步失败',
    ],
    denyImpact: [
      '无法执行同步操作，需管理员介入',
    ],
    privacyRisk: [
      '批量导入可能覆盖/重复数据，需谨慎授权并配合审计',
    ],
  },
  'order.manage': {
    displayName: '订单：管理（中高）',
    riskLevel: 'high',
    purpose: '允许执行订单管理型操作（可能包含状态调整、特殊流程等）。',
    scenarios: [
      '处理异常订单、运营审批类动作、流程收口',
    ],
    denyImpact: [
      '无法处理订单异常或审批动作，影响业务闭环',
    ],
    privacyRisk: [
      '影响订单流程与金额口径，需按岗位严控',
    ],
  },
  'order.cancel': {
    displayName: '订单：取消（中高）',
    riskLevel: 'high',
    purpose: '允许取消订单，可能影响收入与排班。',
    scenarios: [
      '按规则取消订单、处理重复/错误订单',
    ],
    denyImpact: [
      '无法取消订单，需管理员处理',
    ],
    privacyRisk: [
      '误取消会造成财务与客诉风险',
    ],
  },
  'order.create.override': {
    displayName: '订单：创建（绕过校验）（高危）',
    riskLevel: 'high',
    purpose: '允许在非常规情况下创建订单（绕过部分限制），用于紧急修复。',
    scenarios: [
      '紧急数据修复、特殊业务场景（需审批）',
    ],
    denyImpact: [
      '无法在异常情况下强制创建订单，修复速度下降',
    ],
    privacyRisk: [
      '更容易引入错误数据或重复订单，需严格审批与审计',
    ],
  },
  'order.cancel.override': {
    displayName: '订单：取消（绕过校验）（高危）',
    riskLevel: 'high',
    purpose: '允许在非常规情况下取消订单（绕过部分限制），用于紧急处理。',
    scenarios: [
      '紧急止损、纠错或特殊客诉处理（需审批）',
    ],
    denyImpact: [
      '无法在异常情况下强制取消订单，处理效率下降',
    ],
    privacyRisk: [
      '更容易导致误取消与财务偏差，需严格审批与审计',
    ],
  },
  'onboarding.read': {
    displayName: 'Onboarding：查看（低）',
    riskLevel: 'low',
    purpose: '允许查看 onboarding 资料与配置。',
    scenarios: [
      '查看房源上线流程、参考标准配置',
    ],
    denyImpact: [
      '无法查看 onboarding 页面内容',
    ],
    privacyRisk: [
      '可能包含内部流程与资产信息，建议限制范围',
    ],
  },
  'onboarding.manage': {
    displayName: 'Onboarding：管理（中）',
    riskLevel: 'medium',
    purpose: '允许维护 onboarding 配置与资料，影响房源上线质量。',
    scenarios: [
      '编辑上线资料、更新标准与模板',
    ],
    denyImpact: [
      '无法维护 onboarding 信息，影响上线效率',
    ],
    privacyRisk: [
      '错误配置可能导致大范围房源资料不一致',
    ],
  },
  'property_deep_cleaning.audit': {
    displayName: '深度清洁：审核（中高）',
    riskLevel: 'high',
    purpose: '允许审核深度清洁相关记录与资料，可能影响结算与质量闭环。',
    scenarios: [
      '复核任务完成情况、确认质量与结算条件',
    ],
    denyImpact: [
      '无法完成审核，流程可能卡住',
    ],
    privacyRisk: [
      '可能包含照片/视频等敏感内容，需严格控制访问',
    ],
  },
  'cleaning_app.tasks.view.self': {
    displayName: '清洁 App：查看我的任务（低）',
    riskLevel: 'low',
    purpose: '允许清洁人员查看分配给自己的任务。',
    scenarios: [
      '现场人员查看待办、地址与时间安排',
    ],
    denyImpact: [
      '清洁人员无法查看任务列表，无法开展工作',
    ],
    privacyRisk: [
      '可能暴露房源地址与住客行程信息，需按人员范围控制',
    ],
  },
  'cleaning_app.tasks.start': {
    displayName: '清洁 App：开始任务（中）',
    riskLevel: 'medium',
    purpose: '允许标记任务开始，触发流程状态变化。',
    scenarios: [
      '现场开始作业时更新状态',
    ],
    denyImpact: [
      '无法开始任务，状态流转与统计受影响',
    ],
    privacyRisk: [
      '状态变更会影响运营决策与对外承诺',
    ],
  },
  'cleaning_app.tasks.finish': {
    displayName: '清洁 App：完成任务（中）',
    riskLevel: 'medium',
    purpose: '允许标记任务完成，影响房源可售与后续流程。',
    scenarios: [
      '作业完成后提交结果',
    ],
    denyImpact: [
      '无法完成任务，流程无法闭环',
    ],
    privacyRisk: [
      '误完成可能导致质量问题未发现或影响入住体验',
    ],
  },
  'cleaning_app.issues.report': {
    displayName: '清洁 App：上报问题（中）',
    riskLevel: 'medium',
    purpose: '允许提交清洁/房源问题反馈，影响维修与运营决策。',
    scenarios: [
      '上报损坏、遗留物、缺货等问题',
    ],
    denyImpact: [
      '无法上报问题，问题处理滞后',
    ],
    privacyRisk: [
      '可能包含照片与描述，注意敏感内容与合规',
    ],
  },
  'cleaning_app.media.upload': {
    displayName: '清洁 App：上传媒体（中高）',
    riskLevel: 'high',
    purpose: '允许上传照片/视频等媒体资料，用于验收与审计。',
    scenarios: [
      '上传清洁前后对比、钥匙照片、锁盒视频等',
    ],
    denyImpact: [
      '无法上传媒体，验收与追责缺乏证据链',
    ],
    privacyRisk: [
      '媒体内容可能包含个人信息与室内隐私，需最小授权与留存治理',
    ],
  },
  'cleaning_app.restock.manage': {
    displayName: '清洁 App：补货管理（中）',
    riskLevel: 'medium',
    purpose: '允许记录补货需求与处理结果，影响库存与现场保障。',
    scenarios: [
      '登记耗材使用、触发补货流程',
    ],
    denyImpact: [
      '无法记录补货，耗材短缺难以及时发现',
    ],
    privacyRisk: [
      '通常风险较低，但会影响运营与库存数据准确性',
    ],
  },
  'cleaning_app.inspect.finish': {
    displayName: '清洁 App：完成检查（中）',
    riskLevel: 'medium',
    purpose: '允许提交检查完成状态，影响房源交付质量。',
    scenarios: [
      '检查验收后提交结果',
    ],
    denyImpact: [
      '无法完成检查流程，影响交付',
    ],
    privacyRisk: [
      '误操作可能导致质量问题漏检',
    ],
  },
  'cleaning_app.ready.set': {
    displayName: '清洁 App：设为可入住（中高）',
    riskLevel: 'high',
    purpose: '允许将房源/任务标记为就绪，影响销售与入住。',
    scenarios: [
      '确认清洁与检查完成后设置就绪',
    ],
    denyImpact: [
      '无法设置就绪，运营无法放房',
    ],
    privacyRisk: [
      '误设置会带来客诉与运营风险',
    ],
  },
  'cleaning_app.calendar.view.all': {
    displayName: '清洁 App：查看全部日历（中）',
    riskLevel: 'medium',
    purpose: '允许查看全部清洁日历与排班信息。',
    scenarios: [
      '管理者统筹排班与资源',
    ],
    denyImpact: [
      '无法查看全局排班，统筹困难',
    ],
    privacyRisk: [
      '可能暴露所有房源地址与安排，需按岗位控制',
    ],
  },
  'cleaning_app.assign': {
    displayName: '清洁 App：派单/分配（中）',
    riskLevel: 'medium',
    purpose: '允许在 App 侧进行派单与分配操作。',
    scenarios: [
      '现场快速调度、临时转派',
    ],
    denyImpact: [
      '无法派单，需回到后台处理',
    ],
    privacyRisk: [
      '影响人员安排与流程责任，需要控制范围',
    ],
  },
  'cleaning_app.sse.subscribe': {
    displayName: '清洁 App：实时更新订阅（低）',
    riskLevel: 'low',
    purpose: '允许订阅实时状态更新（SSE），提升任务信息的及时性。',
    scenarios: [
      '需要实时看到任务状态变化',
    ],
    denyImpact: [
      '状态更新不及时，需要手动刷新',
    ],
    privacyRisk: [
      '本身不扩大数据范围，但会提升数据分发频率',
    ],
  },
  'cleaning_app.push.subscribe': {
    displayName: '清洁 App：推送订阅（低）',
    riskLevel: 'low',
    purpose: '允许绑定推送通道，用于任务提醒与状态通知。',
    scenarios: [
      '需要接收任务提醒与变更通知',
    ],
    denyImpact: [
      '无法接收推送提醒，可能错过任务变更',
    ],
    privacyRisk: [
      '会记录推送 endpoint 等设备标识信息，需合规留存与可撤销',
    ],
  },
}

export function getPermissionMeta(code: string): PermissionMeta {
  const fixedMeta = fixed[code]
  if (fixedMeta) return makeMeta({ code, ...fixedMeta })

  const byMenu = menuMeta(code)
  if (byMenu) return byMenu

  const byResource = resourceActionMeta(code)
  if (byResource) return byResource

  return makeMeta({
    code,
    displayName: code,
    riskLevel: 'medium',
    purpose: '该权限用于控制系统内某项功能或数据操作。',
    scenarios: ['当用户需要使用对应功能时授予'],
    denyImpact: ['对应功能可能不可用或部分按钮被隐藏/失败'],
    privacyRisk: ['请结合功能上下文评估数据访问范围与误操作风险'],
  })
}
