# Task Update Report

- Base: a32b57c
- Head: b4e1645
- Version: v0.2.7-invoice-types.20260207+build.1
- Author: MZ System Bot
- GeneratedAt: 2026-02-07 12:26:29
- Ticket: 未提供

## File Changes (32)

### 修改 CHANGELOG.md

- 变更类型: 修改
- 路径: CHANGELOG.md
- 关联单号: 未提供

```diff
diff --git a/CHANGELOG.md b/CHANGELOG.md
index 8360c1b..619e859 100644
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -1,5 +1,18 @@
 # Changelog
 
+## v0.2.7-invoice-types.20260207+build.1 (2026-02-07)
+
+- Invoice center: Add Quote/Invoice/Receipt types with permissions (invoice.type.switch).
+- Numbering: company code + INV/QT/REC + YYYY + 4-digit sequence; Receipt number auto-generated on mark-paid/issue.
+- Receipt workflow: keep line items, hide GST; show PAID after Save/Submit (not on select).
+- Templates: type-aware preview/print; Receipt/Quote hide payment info; remove signature section.
+- List UX: records actions use pill buttons (View/Edit/Delete=void) aligned with Properties UI.
+- PDF export: fix layout distortion, email wrapping, and extra blank page.
+- Versions: frontend 0.2.7-invoice-types.20260207+build.1, backend 0.2.7-invoice-types.20260207+build.1.
+
+Author: MZ System Bot <dev@mzpropertygroup.com>
+Commit: b267683
+
 ## Dev (2026-01-16)
 
 - Email sync

```

### 新增 VERSION

- 变更类型: 新增
- 路径: VERSION
- 关联单号: 未提供

```diff
diff --git a/VERSION b/VERSION
new file mode 100644
index 0000000..dab5315
--- /dev/null
+++ b/VERSION
@@ -0,0 +1,2 @@
+0.2.7-invoice-types.20260207+build.1
+

```

### 修改 backend/dist/store.js

- 变更类型: 修改
- 路径: backend/dist/store.js
- 关联单号: 未提供

```diff
diff --git a/backend/dist/store.js b/backend/dist/store.js
index 36c1296..6c0348e 100644
--- a/backend/dist/store.js
+++ b/backend/dist/store.js
@@ -211,7 +211,8 @@ if (exports.db.roles.length === 0) {
         { code: 'invoice.send' },
         { code: 'invoice.void' },
         { code: 'invoice.payment.record' },
-        { code: 'invoice.company.manage' }
+        { code: 'invoice.company.manage' },
+        { code: 'invoice.type.switch' }
     ];
     function grant(roleId, codes) {
         codes.forEach(c => exports.db.rolePermissions.push({ role_id: roleId, permission_code: c }));
@@ -225,7 +226,7 @@ if (exports.db.roles.length === 0) {
     // 清洁/检查人员：无写权限，仅查看（后端接口默认允许 GET）
     grant(cleanerId, ['menu.cleaning', 'menu.dashboard', 'cleaning_app.tasks.view.self', 'cleaning_app.tasks.start', 'cleaning_app.tasks.finish', 'cleaning_app.issues.report', 'cleaning_app.media.upload']);
     // 财务人员：财务结算与交易录入、房东/房源管理
-    grant(financeId, ['finance.payout', 'finance.tx.write', 'invoice.view', 'invoice.draft.create', 'invoice.issue', 'invoice.send', 'invoice.void', 'invoice.payment.record', 'invoice.company.manage', 'order.deduction.manage', 'order.cancel', 'landlord.manage', 'property.write', 'onboarding.manage', 'onboarding.read', 'menu.finance', 'menu.finance.invoices.visible', 'menu.landlords', 'menu.properties', 'menu.onboarding', 'menu.dashboard']);
+    grant(financeId, ['finance.payout', 'finance.tx.write', 'invoice.view', 'invoice.draft.create', 'invoice.issue', 'invoice.send', 'invoice.void', 'invoice.payment.record', 'invoice.company.manage', 'invoice.type.switch', 'order.deduction.manage', 'order.cancel', 'landlord.manage', 'property.write', 'onboarding.manage', 'onboarding.read', 'menu.finance', 'menu.finance.invoices.visible', 'menu.landlords', 'menu.properties', 'menu.onboarding', 'menu.dashboard']);
     // 仓库管理员：仓库与钥匙管理
     grant(inventoryId, ['inventory.move', 'keyset.manage', 'key.flow', 'menu.inventory', 'menu.keys', 'menu.dashboard']);
     // 维修人员：暂无写接口，预留

```

### 修改 backend/package.json

- 变更类型: 修改
- 路径: backend/package.json
- 关联单号: 未提供

```diff
diff --git a/backend/package.json b/backend/package.json
index 75b264a..5249270 100644
--- a/backend/package.json
+++ b/backend/package.json
@@ -1,6 +1,6 @@
 {
   "name": "mz-property-backend",
-  "version": "0.2.5",
+  "version": "0.2.7-invoice-types.20260207+build.1",
   "private": true,
   "scripts": {
     "dev": "ts-node-dev --respawn --transpile-only src/index.ts",

```

### 修改 backend/src/modules/invoices.ts

- 变更类型: 修改
- 路径: backend/src/modules/invoices.ts
- 关联单号: 未提供

```diff
diff --git a/backend/src/modules/invoices.ts b/backend/src/modules/invoices.ts
index b52d860..d4ec12a 100644
--- a/backend/src/modules/invoices.ts
+++ b/backend/src/modules/invoices.ts
@@ -5,9 +5,9 @@ import fs from 'fs'
 import { z } from 'zod'
 import { PDFDocument } from 'pdf-lib'
 import { requireAnyPerm, requirePerm } from '../auth'
-import { hasPg, pgInsert, pgPool, pgRunInTransaction, pgSelect, pgUpdate } from '../dbAdapter'
+import { hasPg, pgDelete, pgInsert, pgPool, pgRunInTransaction, pgSelect, pgUpdate } from '../dbAdapter'
 import { hasR2, r2Upload } from '../r2'
-import { addAudit } from '../store'
+import { addAudit, db, roleHasPermission } from '../store'
 import { v4 as uuid } from 'uuid'
  
 export const router = Router()
@@ -49,19 +49,26 @@ async function ensureInvoiceTables() {
   await pgPool.query(`CREATE TABLE IF NOT EXISTS invoices (
     id text PRIMARY KEY,
     company_id text REFERENCES invoice_companies(id) ON DELETE RESTRICT,
+    invoice_type text DEFAULT 'invoice',
     invoice_no text,
     issue_date date,
     due_date date,
+    valid_until date,
     currency text DEFAULT 'AUD',
     status text DEFAULT 'draft',
+    customer_id text,
     bill_to_name text,
     bill_to_email text,
+    bill_to_phone text,
+    bill_to_abn text,
     bill_to_address text,
     subtotal numeric,
     tax_total numeric,
     total numeric,
     amount_paid numeric DEFAULT 0,
     amount_due numeric,
+    payment_method text,
+    payment_method_note text,
     primary_source_type text,
     primary_source_id text,
     notes text,
@@ -78,11 +85,46 @@ async function ensureInvoiceTables() {
     created_at timestamptz DEFAULT now(),
     updated_at timestamptz
   );`)
+  await pgPool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_id text;`)
+  await pgPool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_type text DEFAULT 'invoice';`)
+  await pgPool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS valid_until date;`)
+  await pgPool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS bill_to_phone text;`)
+  await pgPool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS bill_to_abn text;`)
+  await pgPool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_method text;`)
+  await pgPool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_method_note text;`)
   await pgPool.query('CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices(company_id);')
   await pgPool.query('CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);')
   await pgPool.query('CREATE INDEX IF NOT EXISTS idx_invoices_issue_date ON invoices(issue_date);')
+  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_invoices_type ON invoices(invoice_type);')
   await pgPool.query('CREATE INDEX IF NOT EXISTS idx_invoices_invoice_no ON invoices(invoice_no);')
   await pgPool.query("CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoices_company_invoice_no ON invoices(company_id, invoice_no) WHERE invoice_no IS NOT NULL;")
+
+  await pgPool.query(`CREATE TABLE IF NOT EXISTS invoice_customers (
+    id text PRIMARY KEY,
+    name text NOT NULL,
+    abn text,
+    address text,
+    phone text,
+    email text,
+    status text DEFAULT 'active',
+    created_by text,
+    updated_by text,
+    created_at timestamptz DEFAULT now(),
+    updated_at timestamptz
+  );`)
+  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_invoice_customers_status ON invoice_customers(status);')
+  await pgPool.query("CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoice_customers_abn ON invoice_customers(abn) WHERE abn IS NOT NULL AND abn <> '';")
+
+  await pgPool.query(`CREATE TABLE IF NOT EXISTS invoice_payment_events (
+    id text PRIMARY KEY,
+    invoice_id text REFERENCES invoices(id) ON DELETE CASCADE,
+    status text,
+    payment_method text,
+    payment_method_note text,
+    created_by text,
+    created_at timestamptz DEFAULT now()
+  );`)
+  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_invoice_payment_events_invoice ON invoice_payment_events(invoice_id, created_at DESC);')
  
   await pgPool.query(`CREATE TABLE IF NOT EXISTS invoice_sources (
     invoice_id text REFERENCES invoices(id) ON DELETE CASCADE,
@@ -147,6 +189,16 @@ async function ensureInvoiceTables() {
     updated_at timestamptz,
     UNIQUE(company_id, year)
   );`)
+
+  await pgPool.query(`CREATE TABLE IF NOT EXISTS invoice_number_sequences (
+    id text PRIMARY KEY,
+    company_id text REFERENCES invoice_companies(id) ON DELETE CASCADE,
+    ymd text NOT NULL,
+    invoice_type text NOT NULL,
+    next_value integer NOT NULL,
+    updated_at timestamptz,
+    UNIQUE(company_id, ymd, invoice_type)
+  );`)
   })()
   return invoiceSchemaReady
 }
@@ -165,22 +217,60 @@ function toDateOnly(d: any): string | null {
   if (Number.isNaN(dt.getTime())) return null
   return dt.toISOString().slice(0, 10)
 }
+
+type InvoiceType = 'quote' | 'invoice' | 'receipt'
+function normalizeInvoiceType(v: any): InvoiceType {
+  const s = String(v || '').trim().toLowerCase()
+  if (s === 'quote') return 'quote'
+  if (s === 'receipt') return 'receipt'
+  return 'invoice'
+}
+
+function addDays(dateOnly: string, days: number) {
+  const dt = new Date(`${dateOnly}T00:00:00Z`)
+  dt.setUTCDate(dt.getUTCDate() + Number(days || 0))
+  return dt.toISOString().slice(0, 10)
+}
+
+async function roleHasPermAsync(roleName: string, code: string) {
+  if (roleName === 'admin') return true
+  let ok = false
+  try {
+    if (hasPg && pgPool) {
+      let roleId = db.roles.find(r => r.name === roleName)?.id
+      try {
+        const r0 = await pgPool.query('SELECT id FROM roles WHERE name=$1 LIMIT 1', [roleName])
+        if (r0 && r0.rows && r0.rows[0] && r0.rows[0].id) roleId = String(r0.rows[0].id)
+      } catch {}
+      const roleIds = Array.from(new Set([roleId, roleName, roleName.startsWith('role.') ? roleName.replace(/^role\./, '') : `role.${roleName}`].filter(Boolean)))
+      const r = await pgPool.query('SELECT 1 FROM role_permissions WHERE role_id = ANY($1::text[]) AND permission_code = $2 LIMIT 1', [roleIds, code])
+      ok = !!r?.rowCount
+    }
+  } catch {}
+  if (!ok) ok = roleHasPermission(roleName, code)
+  return ok
+}
  
 function round2(n: any) {
   const x = Number(n || 0)
   return Math.round(x * 100) / 100
 }
  
-type GstType = 'GST_10' | 'GST_FREE' | 'INPUT_TAXED'
+type GstType = 'GST_10' | 'GST_INCLUDED_10' | 'GST_FREE' | 'INPUT_TAXED'
  
 function computeLine(item: { quantity: number; unit_price: number; gst_type: GstType }) {
   const qty = Number(item.quantity || 0)
   const unit = Number(item.unit_price || 0)
-  const lineSubtotal = round2(qty * unit)
+  const base = round2(qty * unit)
+  if (item.gst_type === 'GST_INCLUDED_10') {
+    const tax = round2(base / 11)
+    const sub = round2(base - tax)
+    return { line_subtotal: sub, tax_amount: tax, line_total: base }
+  }
   let tax = 0
-  if (item.gst_type === 'GST_10') tax = round2(lineSubtotal * 0.1)
-  const lineTotal = round2(lineSubtotal + tax)
-  return { line_subtotal: lineSubtotal, tax_amount: tax, line_total: lineTotal }
+  if (item.gst_type === 'GST_10') tax = round2(base * 0.1)
+  const lineTotal = round2(base + tax)
+  return { line_subtotal: base, tax_amount: tax, line_total: lineTotal }
 }
  
 function computeTotals(lines: Array<{ line_subtotal: number; tax_amount: number; line_total: number }>, amountPaid: any) {
@@ -213,25 +303,56 @@ async function nextInvoiceNo(companyId: string, year: number, client: any) {
   await client.query('UPDATE number_sequences SET next_value=$1, updated_at=now() WHERE company_id=$2 AND year=$3', [nextValue + 1, companyId, year])
   return invoiceNo
 }
+
+function invoiceTypePrefix(t: InvoiceType) {
+  if (t === 'quote') return 'QT'
+  if (t === 'receipt') return 'REC'
+  return 'INV'
+}
+
+async function nextInvoiceNoByType(companyId: string, invoiceType: InvoiceType, issueDate: string, client: any) {
+  const year = String(issueDate || '').slice(0, 4)
+  if (!/^\d{4}$/.test(year)) throw new Error('invalid_issue_date')
+  const prefix = invoiceTypePrefix(invoiceType)
+  const compRs = await client.query('SELECT code FROM invoice_companies WHERE id=$1 LIMIT 1', [companyId])
+  const companyCode = String(compRs?.rows?.[0]?.code || '').trim() || 'INV'
+  const row = await client.query('SELECT * FROM invoice_number_sequences WHERE company_id=$1 AND ymd=$2 AND invoice_type=$3 FOR UPDATE', [companyId, year, invoiceType])
+  let seq = row?.rows?.[0]
+  if (!seq) {
+    const ins = await client.query(
+      'INSERT INTO invoice_number_sequences (id, company_id, ymd, invoice_type, next_value, updated_at) VALUES ($1,$2,$3,$4,$5, now()) RETURNING *',
+      [uuid(), companyId, year, invoiceType, 1]
+    )
+    seq = ins?.rows?.[0]
+  }
+  const nextValue = Number(seq?.next_value || 1)
... (diff truncated) ...
```

### 修改 backend/src/modules/public.ts

- 变更类型: 修改
- 路径: backend/src/modules/public.ts
- 关联单号: 未提供

```diff
diff --git a/backend/src/modules/public.ts b/backend/src/modules/public.ts
index 69b45c4..822613e 100644
--- a/backend/src/modules/public.ts
+++ b/backend/src/modules/public.ts
@@ -1,7 +1,7 @@
 import { Router } from 'express'
 import multer from 'multer'
 import path from 'path'
-import { hasR2, r2Upload } from '../r2'
+import { hasR2, r2GetObjectByKey, r2KeyFromUrl, r2Upload } from '../r2'
 import { v4 as uuidv4 } from 'uuid'
 import { hasPg, pgPool, pgSelect, pgInsert, pgUpdate } from '../dbAdapter'
 import jwt from 'jsonwebtoken'
@@ -20,6 +20,27 @@ const DEFAULT_PUBLIC_PROPERTY_EXPENSE_PASSWORD = process.env.PROPERTY_EXPENSE_PU
 export const router = Router()
 const upload = multer({ storage: multer.memoryStorage() })
 
+router.get('/r2-image', async (req, res) => {
+  try {
+    const u = String((req.query as any)?.url || (req.query as any)?.u || '').trim()
+    if (!u) return res.status(400).json({ message: 'missing_url' })
+    if (!hasR2) return res.status(404).json({ message: 'r2_not_configured' })
+    const key = r2KeyFromUrl(u)
+    if (!key) return res.status(400).json({ message: 'invalid_r2_url' })
+    if (!key.startsWith('invoice-company-logos/')) return res.status(403).json({ message: 'forbidden_key' })
+    const obj = await r2GetObjectByKey(key)
+    if (!obj || !obj.body?.length) return res.status(404).json({ message: 'not_found' })
+    res.setHeader('Access-Control-Allow-Origin', '*')
+    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
+    res.setHeader('Content-Type', obj.contentType || 'application/octet-stream')
+    res.setHeader('Cache-Control', obj.cacheControl || 'public, max-age=86400, stale-while-revalidate=604800')
+    if (obj.etag) res.setHeader('ETag', obj.etag)
+    return res.status(200).send(obj.body)
+  } catch (e: any) {
+    return res.status(500).json({ message: e?.message || 'proxy_failed' })
+  }
+})
+
 function randomSuffix(len: number): string {
   const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
   let s = ''

```

### 修改 backend/src/permissionsCatalog.ts

- 变更类型: 修改
- 路径: backend/src/permissionsCatalog.ts
- 关联单号: 未提供

```diff
diff --git a/backend/src/permissionsCatalog.ts b/backend/src/permissionsCatalog.ts
index 042bcbe..2b72a53 100644
--- a/backend/src/permissionsCatalog.ts
+++ b/backend/src/permissionsCatalog.ts
@@ -327,6 +327,21 @@ const fixed: Record<string, Omit<PermissionMeta, 'code'>> = {
       '包含银行账户等敏感信息，需最小授权',
     ],
   },
+  'invoice.type.switch': {
+    displayName: '发票中心：切换发票类型（高危）',
+    riskLevel: 'high',
+    purpose: '允许在报价单/发票/收据之间切换类型，影响编号规则、模板内容与财务口径。',
+    scenarios: [
+      '财务根据业务场景创建报价单或收据',
+      '调整草稿阶段的凭证类型并生成对应编号',
+    ],
+    denyImpact: [
+      '普通用户只能使用默认“发票”类型',
+    ],
+    privacyRisk: [
+      '误选类型可能造成合规/对账偏差，需严格授权与审计',
+    ],
+  },
   'landlord.manage': {
     displayName: '房东：资料管理（中）',
     riskLevel: 'medium',

```

### 修改 backend/src/r2.ts

- 变更类型: 修改
- 路径: backend/src/r2.ts
- 关联单号: 未提供

```diff
diff --git a/backend/src/r2.ts b/backend/src/r2.ts
index 37567ca..837bd46 100644
--- a/backend/src/r2.ts
+++ b/backend/src/r2.ts
@@ -1,4 +1,4 @@
-import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
+import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
 
 const endpoint = process.env.R2_ENDPOINT || ''
 const accessKeyId = process.env.R2_ACCESS_KEY_ID || ''
@@ -39,6 +39,58 @@ function computePublicBase(): string {
   return cleaned || `${endpoint.replace(/\/$/, '')}/${bucket}`
 }
 
+export function r2KeyFromUrl(url: string): string | null {
+  try {
+    if (!hasR2) return null
+    const clean = String(url || '').trim().replace(/\?[^#]*$/, '')
+    if (!clean) return null
+    try {
+      const u = new URL(clean)
+      const host = String(u.hostname || '').toLowerCase()
+      if (host.endsWith('.r2.dev')) {
+        const key = String(u.pathname || '').replace(/^\//, '')
+        return key || null
+      }
+    } catch {}
+    const base1 = computePublicBase()
+    const base2 = `${endpoint.replace(/\/$/, '')}/${bucket}`
+    if (clean.startsWith(base1 + '/')) return clean.slice(base1.length + 1) || null
+    if (clean.startsWith(base2 + '/')) return clean.slice(base2.length + 1) || null
+    return null
+  } catch {
+    return null
+  }
+}
+
+async function streamToBuffer(body: any): Promise<Buffer> {
+  if (!body) return Buffer.from([])
+  if (typeof body.transformToByteArray === 'function') {
+    const arr = await body.transformToByteArray()
+    return Buffer.from(arr)
+  }
+  const chunks: Buffer[] = []
+  await new Promise<void>((resolve, reject) => {
+    body.on('data', (c: any) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
+    body.on('end', () => resolve())
+    body.on('error', (e: any) => reject(e))
+  })
+  return Buffer.concat(chunks)
+}
+
+export async function r2GetObjectByKey(key: string): Promise<{ body: Buffer; contentType: string; cacheControl?: string; etag?: string } | null> {
+  try {
+    if (!hasR2 || !r2) return null
+    const resp: any = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
+    const body = await streamToBuffer(resp?.Body)
+    const contentType = String(resp?.ContentType || 'application/octet-stream')
+    const cacheControl = resp?.CacheControl ? String(resp.CacheControl) : undefined
+    const etag = resp?.ETag ? String(resp.ETag).replace(/"/g, '') : undefined
+    return { body, contentType, cacheControl, etag }
+  } catch {
+    return null
+  }
+}
+
 export async function r2DeleteByUrl(url: string): Promise<boolean> {
   try {
     if (!hasR2 || !r2) return false

```

### 修改 backend/src/store.ts

- 变更类型: 修改
- 路径: backend/src/store.ts
- 关联单号: 未提供

```diff
diff --git a/backend/src/store.ts b/backend/src/store.ts
index 27b0418..fb81674 100644
--- a/backend/src/store.ts
+++ b/backend/src/store.ts
@@ -448,7 +448,8 @@ if (db.roles.length === 0) {
     { code: 'invoice.send' },
     { code: 'invoice.void' },
     { code: 'invoice.payment.record' },
-    { code: 'invoice.company.manage' }
+    { code: 'invoice.company.manage' },
+    { code: 'invoice.type.switch' }
   ]
   function grant(roleId: string, codes: string[]) {
     codes.forEach(c => db.rolePermissions.push({ role_id: roleId, permission_code: c }))
@@ -462,7 +463,7 @@ if (db.roles.length === 0) {
   // 清洁/检查人员：无写权限，仅查看（后端接口默认允许 GET）
   grant(cleanerId, ['menu.cleaning','menu.dashboard','cleaning_app.tasks.view.self','cleaning_app.tasks.start','cleaning_app.tasks.finish','cleaning_app.issues.report','cleaning_app.media.upload'])
   // 财务人员：财务结算与交易录入、房东/房源管理
-  grant(financeId, ['finance.payout','finance.tx.write','invoice.view','invoice.draft.create','invoice.issue','invoice.send','invoice.void','invoice.payment.record','invoice.company.manage','order.deduction.manage','order.cancel','landlord.manage','property.write','onboarding.manage','onboarding.read','menu.finance','menu.finance.invoices.visible','menu.landlords','menu.properties','menu.onboarding','menu.dashboard'])
+  grant(financeId, ['finance.payout','finance.tx.write','invoice.view','invoice.draft.create','invoice.issue','invoice.send','invoice.void','invoice.payment.record','invoice.company.manage','invoice.type.switch','order.deduction.manage','order.cancel','landlord.manage','property.write','onboarding.manage','onboarding.read','menu.finance','menu.finance.invoices.visible','menu.landlords','menu.properties','menu.onboarding','menu.dashboard'])
   // 仓库管理员：仓库与钥匙管理
   grant(inventoryId, ['inventory.move','keyset.manage','key.flow','menu.inventory','menu.keys','menu.dashboard'])
   // 维修人员：暂无写接口，预留

```

### 新增 frontend/.eslintrc.json

- 变更类型: 新增
- 路径: frontend/.eslintrc.json
- 关联单号: 未提供

```diff
diff --git a/frontend/.eslintrc.json b/frontend/.eslintrc.json
new file mode 100644
index 0000000..24e1c6c
--- /dev/null
+++ b/frontend/.eslintrc.json
@@ -0,0 +1,6 @@
+{
+  "extends": "next/core-web-vitals",
+  "rules": {
+    "react/jsx-key": "off"
+  }
+}

```

### 新增 frontend/docs/invoice-pdf-export.md

- 变更类型: 新增
- 路径: frontend/docs/invoice-pdf-export.md
- 关联单号: 未提供

```diff
diff --git a/frontend/docs/invoice-pdf-export.md b/frontend/docs/invoice-pdf-export.md
new file mode 100644
index 0000000..8dfe46e
--- /dev/null
+++ b/frontend/docs/invoice-pdf-export.md
@@ -0,0 +1,22 @@
+# 发票导出 PDF 说明
+
+## 导出原理
+
+- 发票预览页使用 iframe 加载发票模板（HTML + CSS + JS）并渲染成 A4 版式。
+- 导出 PDF 时，会等待 iframe 内图片与字体加载完成，然后对 `.inv-sheet` 进行截图（html2canvas），再按 A4 高度切片写入 PDF（jsPDF）。
+
+## Logo（R2）加载策略
+
+- 若公司 Logo 链接为 R2（例如 `*.r2.dev`），预览页会自动改为走后端代理 `/public/r2-image?url=...`。
+- 代理会从 R2 直接读取对象并返回跨域允许的图片响应，避免浏览器截图阶段因跨域导致图片缺失。
+
+## 常见问题与排查
+
+- PDF 中图片缺失：优先检查 Logo 链接是否可访问；若为 R2 私有对象，需确保后端已配置 R2，并可通过代理接口返回 200。
+- 字体显示异常：导出前会等待 `document.fonts.ready`（若浏览器支持）；仍异常时建议检查系统字体可用性与浏览器版本。
+- 页面布局错乱：导出时会临时移除阴影/圆角/外层 padding，确保以 A4 内容区为准进行截图。
+
+## 变更说明
+
+- 预览页已移除“下载对比图 / 下载多端预览图 / 下载对齐报告”等调试入口，避免影响用户导出体验与维护成本。
+

```

### 修改 frontend/middleware.ts

- 变更类型: 修改
- 路径: frontend/middleware.ts
- 关联单号: 未提供

```diff
diff --git a/frontend/middleware.ts b/frontend/middleware.ts
index c7bb011..c8e4586 100644
--- a/frontend/middleware.ts
+++ b/frontend/middleware.ts
@@ -3,8 +3,9 @@ import type { NextRequest } from 'next/server'
 
 export function middleware(req: NextRequest) {
   const { pathname } = req.nextUrl
-  const publicPaths = ['/login', '/_next', '/favicon', '/company-logo.png']
+  const publicPaths = ['/login', '/_next', '/favicon', '/company-logo.png', '/mz-logo.png', '/public', '/public-cleaning-guide']
   if (publicPaths.some(p => pathname.startsWith(p))) return NextResponse.next()
+  if (/\.[a-zA-Z0-9]+$/.test(pathname)) return NextResponse.next()
   const token = req.cookies.get('auth')?.value
   if (!token) {
     const url = req.nextUrl.clone(); url.pathname = '/login'
@@ -15,4 +16,4 @@ export function middleware(req: NextRequest) {
 
 export const config = {
   matcher: ['/((?!api).*)']
-}
\ No newline at end of file
+}

```

### 修改 frontend/package-lock.json

- 变更类型: 修改
- 路径: frontend/package-lock.json
- 关联单号: 未提供

```diff
diff --git a/frontend/package-lock.json b/frontend/package-lock.json
index 2db0f0c..ef5ba95 100644
--- a/frontend/package-lock.json
+++ b/frontend/package-lock.json
@@ -1,12 +1,12 @@
 {
   "name": "mz-property-frontend",
-  "version": "0.2.3",
+  "version": "0.2.7-invoice-types.20260207+build.1",
   "lockfileVersion": 3,
   "requires": true,
   "packages": {
     "": {
       "name": "mz-property-frontend",
-      "version": "0.2.3",
+      "version": "0.2.7-invoice-types.20260207+build.1",
       "dependencies": {
         "@ant-design/icons": "^5.3.6",
         "@fullcalendar/daygrid": "^6.1.20",
@@ -26,6 +26,8 @@
         "@types/node": "^20.11.30",
         "@types/react": "^18.3.8",
         "autoprefixer": "^10.4.23",
+        "eslint": "^8.57.1",
+        "eslint-config-next": "^14.2.11",
         "postcss": "^8.5.6",
         "tailwindcss": "^4.1.18",
         "typescript": "^5.6.3",
@@ -143,6 +145,40 @@
         "node": ">=6.9.0"
       }
     },
+    "node_modules/@emnapi/core": {
+      "version": "1.8.1",
+      "resolved": "https://registry.npmjs.org/@emnapi/core/-/core-1.8.1.tgz",
+      "integrity": "sha512-AvT9QFpxK0Zd8J0jopedNm+w/2fIzvtPKPjqyw9jwvBaReTTqPBk9Hixaz7KbjimP+QNz605/XnjFcDAL2pqBg==",
+      "dev": true,
+      "license": "MIT",
+      "optional": true,
+      "dependencies": {
+        "@emnapi/wasi-threads": "1.1.0",
+        "tslib": "^2.4.0"
+      }
+    },
+    "node_modules/@emnapi/runtime": {
+      "version": "1.8.1",
+      "resolved": "https://registry.npmjs.org/@emnapi/runtime/-/runtime-1.8.1.tgz",
+      "integrity": "sha512-mehfKSMWjjNol8659Z8KxEMrdSJDDot5SXMq00dM8BN4o+CLNXQ0xH2V7EchNHV4RmbZLmmPdEaXZc5H2FXmDg==",
+      "dev": true,
+      "license": "MIT",
+      "optional": true,
+      "dependencies": {
+        "tslib": "^2.4.0"
+      }
+    },
+    "node_modules/@emnapi/wasi-threads": {
+      "version": "1.1.0",
+      "resolved": "https://registry.npmjs.org/@emnapi/wasi-threads/-/wasi-threads-1.1.0.tgz",
+      "integrity": "sha512-WI0DdZ8xFSbgMjR1sFsKABJ/C5OnRrjT06JXbZKexJGrDuPTzZdDYfFlsgcCXCyf+suG5QU2e/y1Wo2V/OapLQ==",
+      "dev": true,
+      "license": "MIT",
+      "optional": true,
+      "dependencies": {
+        "tslib": "^2.4.0"
+      }
+    },
     "node_modules/@emotion/hash": {
       "version": "0.8.0",
       "resolved": "https://registry.npmjs.org/@emotion/hash/-/hash-0.8.0.tgz",
@@ -544,6 +580,69 @@
         "node": ">=12"
       }
     },
+    "node_modules/@eslint-community/eslint-utils": {
+      "version": "4.9.1",
+      "resolved": "https://registry.npmjs.org/@eslint-community/eslint-utils/-/eslint-utils-4.9.1.tgz",
+      "integrity": "sha512-phrYmNiYppR7znFEdqgfWHXR6NCkZEK7hwWDHZUjit/2/U0r6XvkDl0SYnoM51Hq7FhCGdLDT6zxCCOY1hexsQ==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "eslint-visitor-keys": "^3.4.3"
+      },
+      "engines": {
+        "node": "^12.22.0 || ^14.17.0 || >=16.0.0"
+      },
+      "funding": {
+        "url": "https://opencollective.com/eslint"
+      },
+      "peerDependencies": {
+        "eslint": "^6.0.0 || ^7.0.0 || >=8.0.0"
+      }
+    },
+    "node_modules/@eslint-community/regexpp": {
+      "version": "4.12.2",
+      "resolved": "https://registry.npmjs.org/@eslint-community/regexpp/-/regexpp-4.12.2.tgz",
+      "integrity": "sha512-EriSTlt5OC9/7SXkRSCAhfSxxoSUgBm33OH+IkwbdpgoqsSsUg7y3uh+IICI/Qg4BBWr3U2i39RpmycbxMq4ew==",
+      "dev": true,
+      "license": "MIT",
+      "engines": {
+        "node": "^12.0.0 || ^14.0.0 || >=16.0.0"
+      }
+    },
+    "node_modules/@eslint/eslintrc": {
+      "version": "2.1.4",
+      "resolved": "https://registry.npmjs.org/@eslint/eslintrc/-/eslintrc-2.1.4.tgz",
+      "integrity": "sha512-269Z39MS6wVJtsoUl10L60WdkhJVdPG24Q4eZTH3nnF6lpvSShEK3wQjDX9JRWAUPvPh7COouPpU9IrqaZFvtQ==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "ajv": "^6.12.4",
+        "debug": "^4.3.2",
+        "espree": "^9.6.0",
+        "globals": "^13.19.0",
+        "ignore": "^5.2.0",
+        "import-fresh": "^3.2.1",
+        "js-yaml": "^4.1.0",
+        "minimatch": "^3.1.2",
+        "strip-json-comments": "^3.1.1"
+      },
+      "engines": {
+        "node": "^12.22.0 || ^14.17.0 || >=16.0.0"
+      },
+      "funding": {
+        "url": "https://opencollective.com/eslint"
+      }
+    },
+    "node_modules/@eslint/js": {
+      "version": "8.57.1",
+      "resolved": "https://registry.npmjs.org/@eslint/js/-/js-8.57.1.tgz",
+      "integrity": "sha512-d9zaMRSTIKDLhctzH12MtXvJKSSUhaHcjV+2Z+GK+EEY7XKpP5yR4x+N3TAcHTcu963nIr+TMcCb4DBCYX1z6Q==",
+      "dev": true,
+      "license": "MIT",
+      "engines": {
+        "node": "^12.22.0 || ^14.17.0 || >=16.0.0"
+      }
+    },
     "node_modules/@fullcalendar/core": {
       "version": "6.1.20",
       "resolved": "https://registry.npmjs.org/@fullcalendar/core/-/core-6.1.20.tgz",
@@ -583,6 +682,91 @@
         "react-dom": "^16.7.0 || ^17 || ^18 || ^19"
       }
     },
+    "node_modules/@humanwhocodes/config-array": {
+      "version": "0.13.0",
+      "resolved": "https://registry.npmjs.org/@humanwhocodes/config-array/-/config-array-0.13.0.tgz",
+      "integrity": "sha512-DZLEEqFWQFiyK6h5YIeynKx7JlvCYWL0cImfSRXZ9l4Sg2efkFGTuFf6vzXjK1cq6IYkU+Eg/JizXw+TD2vRNw==",
+      "deprecated": "Use @eslint/config-array instead",
+      "dev": true,
+      "license": "Apache-2.0",
+      "dependencies": {
+        "@humanwhocodes/object-schema": "^2.0.3",
+        "debug": "^4.3.1",
+        "minimatch": "^3.0.5"
+      },
+      "engines": {
+        "node": ">=10.10.0"
+      }
+    },
+    "node_modules/@humanwhocodes/module-importer": {
+      "version": "1.0.1",
+      "resolved": "https://registry.npmjs.org/@humanwhocodes/module-importer/-/module-importer-1.0.1.tgz",
+      "integrity": "sha512-bxveV4V8v5Yb4ncFTT3rPSgZBOpCkjfK0y4oVVVJwIuDVBRMDXrPyXRL988i5ap9m9bnyEEjWfm5WkBmtffLfA==",
+      "dev": true,
+      "license": "Apache-2.0",
+      "engines": {
+        "node": ">=12.22"
+      },
+      "funding": {
+        "type": "github",
+        "url": "https://github.com/sponsors/nzakas"
+      }
+    },
+    "node_modules/@humanwhocodes/object-schema": {
+      "version": "2.0.3",
+      "resolved": "https://registry.npmjs.org/@humanwhocodes/object-schema/-/object-schema-2.0.3.tgz",
+      "integrity": "sha512-93zYdMES/c1D69yZiKDBj0V24vqNzB/koF26KPaagAfd3P/4gUlh3Dys5ogAK+Exi9QyzlD8x/08Zt7wIKcDcA==",
+      "deprecated": "Use @eslint/object-schema instead",
+      "dev": true,
+      "license": "BSD-3-Clause"
+    },
+    "node_modules/@isaacs/cliui": {
+      "version": "8.0.2",
+      "resolved": "https://registry.npmjs.org/@isaacs/cliui/-/cliui-8.0.2.tgz",
+      "integrity": "sha512-O8jcjabXaleOG9DQ0+ARXWZBTfnP4WNAqzuiJK7ll44AmxGKv/J2M4TPjxjY3znBCfvBXFzucm1twdyFybFqEA==",
+      "dev": true,
+      "license": "ISC",
+      "dependencies": {
+        "string-width": "^5.1.2",
+        "string-width-cjs": "npm:string-width@^4.2.0",
+        "strip-ansi": "^7.0.1",
+        "strip-ansi-cjs": "npm:strip-ansi@^6.0.1",
+        "wrap-ansi": "^8.1.0",
+        "wrap-ansi-cjs": "npm:wrap-ansi@^7.0.0"
+      },
+      "engines": {
+        "node": ">=12"
+      }
+    },
+    "node_modules/@isaacs/cliui/node_modules/ansi-regex": {
... (diff truncated) ...
```

### 修改 frontend/package.json

- 变更类型: 修改
- 路径: frontend/package.json
- 关联单号: 未提供

```diff
diff --git a/frontend/package.json b/frontend/package.json
index 29623c9..efe0a50 100644
--- a/frontend/package.json
+++ b/frontend/package.json
@@ -1,6 +1,6 @@
 {
   "name": "mz-property-frontend",
-  "version": "0.2.6",
+  "version": "0.2.7-invoice-types.20260207+build.1",
   "private": true,
   "scripts": {
     "clean:next": "node scripts/clean-next-cache.mjs",
@@ -32,6 +32,8 @@
     "@types/node": "^20.11.30",
     "@types/react": "^18.3.8",
     "autoprefixer": "^10.4.23",
+    "eslint": "^8.57.1",
+    "eslint-config-next": "^14.2.11",
     "postcss": "^8.5.6",
     "tailwindcss": "^4.1.18",
     "typescript": "^5.6.3",

```

### 修改 frontend/public/invoice-templates/invoice-template.css

- 变更类型: 修改
- 路径: frontend/public/invoice-templates/invoice-template.css
- 关联单号: 未提供

```diff
diff --git a/frontend/public/invoice-templates/invoice-template.css b/frontend/public/invoice-templates/invoice-template.css
index e7d6d41..ee10102 100644
--- a/frontend/public/invoice-templates/invoice-template.css
+++ b/frontend/public/invoice-templates/invoice-template.css
@@ -13,6 +13,7 @@
   --inv-muted:rgba(17,24,39,0.65);
   --inv-border:rgba(0,0,0,0.08);
   --inv-soft:rgba(0,0,0,0.03);
+  --inv-card-pad-x:14px;
   --inv-a4-w:210mm;
   --inv-a4-h:297mm;
   --inv-margin:20mm;
@@ -81,8 +82,9 @@ body{
   gap:12px;
 }
 .inv-logo img{
-  width:140px;
-  height:auto;
+  width:auto;
+  height:160px;
+  max-width:280px;
   object-fit:contain;
 }
 .inv-title{
@@ -98,6 +100,15 @@ body{
   margin-top:8px;
   font-size:var(--inv-font-body);
   color:var(--inv-muted);
+  word-break:break-word;
+  overflow-wrap:anywhere;
+  display:flex;
+  flex-direction:column;
+  align-items:flex-end;
+}
+.inv-title .company .company-line{
+  max-width:100%;
+  text-align:right;
   white-space:pre-wrap;
 }
 
@@ -130,6 +141,10 @@ body{
   font-weight:600;
   letter-spacing:0.01em;
 }
+.inv-band .text{
+  overflow-wrap:anywhere;
+  word-break:break-word;
+}
 
 .inv-table{
   margin-top:16px;
@@ -166,6 +181,22 @@ body{
   overflow-wrap:anywhere;
   font-weight:400;
 }
+.inv-table .desc .li-title{
+  font-weight:700;
+  color:var(--inv-text);
+  white-space:pre-wrap;
+  word-break:break-word;
+  overflow-wrap:anywhere;
+}
+.inv-table .desc .li-content{
+  margin-top:4px;
+  color:var(--inv-muted);
+  font-size:12px;
+  line-height:1.45;
+  white-space:pre-wrap;
+  word-break:break-word;
+  overflow-wrap:anywhere;
+}
 
 .inv-footer-grid{
   margin-top:18px;
@@ -186,7 +217,7 @@ body{
 .inv-card{
   border:1px solid var(--inv-border);
   border-radius:10px;
-  padding:12px 14px;
+  padding:12px var(--inv-card-pad-x);
 }
 .inv-card h3{
   margin:0 0 10px 0;
@@ -200,6 +231,7 @@ body{
   color:var(--inv-muted);
   white-space:pre-wrap;
   word-break:break-word;
+  overflow-wrap:anywhere;
 }
 
 .inv-summary{
@@ -226,15 +258,17 @@ body{
   margin-top:14px;
   background:var(--inv-soft);
   border-radius:10px;
-  padding:12px 14px;
+  padding:12px var(--inv-card-pad-x);
   display:flex;
   justify-content:space-between;
   align-items:flex-end;
+  gap:12px;
 }
 .inv-amount-due .label{
   font-size:12px;
   font-weight:600;
   color:var(--inv-muted);
+  white-space:nowrap;
 }
 .inv-amount-due .value{
   font-size:var(--inv-font-amount);
@@ -242,6 +276,7 @@ body{
   letter-spacing:0.02em;
   font-variant-numeric: tabular-nums;
   font-feature-settings: "tnum" 1;
+  text-align:right;
 }
 .inv-amount-due .value .cur{
   font-size:12px;
@@ -249,6 +284,31 @@ body{
   color:var(--inv-muted);
   margin-left:6px;
 }
+.inv-pay-status{
+  margin-top:4px;
+  font-size:12px;
+  font-weight:700;
+  letter-spacing:0.04em;
+  color:var(--inv-muted);
+}
+.inv-pay-method{
+  margin-top:2px;
+  font-size:11px;
+  font-weight:500;
+  color:var(--inv-muted);
+  overflow-wrap:anywhere;
+  word-break:break-word;
+}
+
+.inv-footer-right{
+  width:100%;
+}
+
+.inv-summary-card .inv-amount-due{
+  margin-left: calc(var(--inv-card-pad-x) * -1);
+  margin-right: calc(var(--inv-card-pad-x) * -1);
+  border-radius:0 0 10px 10px;
+}
 
 .inv-watermark{
   position:absolute;
@@ -283,29 +343,50 @@ body{
   background:rgba(0,82,217,0.06);
 }
 
+.inv-disclaimer{
+  margin-top: 14px;
+  font-size: 12px;
+  color: var(--inv-muted);
+  padding: 0 2px;
+}
+
 @media (max-width: 768px){
   .inv-preview-wrap{padding:12px;}
   .inv-sheet{border-radius:8px;}
   .inv-page{padding:16px;}
   .inv-header{grid-template-columns:1fr; gap:10px;}
-  .inv-title{text-align:left;}
   .inv-band{grid-template-columns:1fr;}
   .inv-footer-grid{grid-template-columns:1fr;}
 }
 
 @media print{
   @page{ size:A4; margin:0; }
+  html,body{ width:var(--inv-a4-w); height:var(--inv-a4-h); }
   body{ background:#fff; }
   .inv-preview-wrap{ padding:0; }
   .inv-sheet{
     width:var(--inv-a4-w);
-    min-height:var(--inv-a4-h);
+    height:var(--inv-a4-h);
+    min-height:0;
     border:none;
     border-radius:0;
     box-shadow:none;
+    overflow:hidden;
   }
   .inv-page{
     padding:var(--inv-margin);
+    height:var(--inv-a4-h);
+    min-height:0;
+    box-sizing:border-box;
+  }
+  .inv-header{ grid-template-columns: 1fr 1fr; gap:16px; }
+  .inv-title{ text-align:right; }
+  .inv-band{ grid-template-columns: 1fr 1fr; }
+  .inv-footer-grid{ grid-template-columns: 1fr 0.9fr; }
+  .inv-card{ break-inside: avoid; page-break-inside: avoid; }
+  .inv-logo img{
+    height:120px;
+    max-width:260px;
... (diff truncated) ...
```

### 修改 frontend/public/invoice-templates/invoice-template.js

- 变更类型: 修改
- 路径: frontend/public/invoice-templates/invoice-template.js
- 关联单号: 未提供

```diff
diff --git a/frontend/public/invoice-templates/invoice-template.js b/frontend/public/invoice-templates/invoice-template.js
index 54bc538..6e8862a 100644
--- a/frontend/public/invoice-templates/invoice-template.js
+++ b/frontend/public/invoice-templates/invoice-template.js
@@ -27,14 +27,41 @@
       .replace(/'/g, '&#39;')
   }
 
+  function splitItemDesc(raw) {
+    var s0 = String(raw == null ? '' : raw).replace(/\r\n/g, '\n').trim()
+    if (!s0) return { title: '-', content: '' }
+    var parts = s0.split('\n')
+    var title = String(parts.shift() || '').trim()
+    var content = parts.join('\n').trim()
+    if (!title && content) {
+      var p2 = content.split('\n')
+      title = String(p2.shift() || '').trim()
+      content = p2.join('\n').trim()
+    }
+    return { title: title || '-', content: content }
+  }
+
+  function renderItemDescHtml(raw) {
+    var d = splitItemDesc(raw)
+    var html = '<div class="li-title">' + escapeHtml(d.title || '-') + '</div>'
+    if (d.content) html += '<div class="li-content">' + escapeHtml(d.content) + '</div>'
+    return html
+  }
+
   function computeLine(item) {
     var qty = Number(item.quantity || 0)
     var unit = Number(item.unit_price || 0)
-    var sub = round2(qty * unit)
+    var base = round2(qty * unit)
+    var t = String(item.gst_type || 'GST_10')
+    if (t === 'GST_INCLUDED_10') {
+      var taxInc = round2(base / 11)
+      var subInc = round2(base - taxInc)
+      return { line_subtotal: subInc, tax_amount: taxInc, line_total: base }
+    }
     var tax = 0
-    if (String(item.gst_type || 'GST_10') === 'GST_10') tax = round2(sub * 0.1)
-    var total = round2(sub + tax)
-    return { line_subtotal: sub, tax_amount: tax, line_total: total }
+    if (t === 'GST_10') tax = round2(base * 0.1)
+    var total = round2(base + tax)
+    return { line_subtotal: base, tax_amount: tax, line_total: total }
   }
 
   function computeTotals(lines, paid) {
@@ -52,6 +79,37 @@
     return { subtotal: subtotal, tax_total: taxTotal, total: total, amount_paid: amountPaid, amount_due: due }
   }
 
+  function gstLabel(items) {
+    var hasInc = false, hasExc = false
+    for (var i = 0; i < items.length; i++) {
+      var t = String(items[i] && items[i].gst_type || '')
+      if (t === 'GST_INCLUDED_10') hasInc = true
+      else if (t === 'GST_10') hasExc = true
+    }
+    if (hasInc && !hasExc) return 'GST included'
+    if (hasExc && !hasInc) return 'GST excluded'
+    if (!hasInc && !hasExc) return 'No GST'
+    return 'GST'
+  }
+
+  function payStatus(inv, totals) {
+    var st = String(inv && inv.status || '')
+    if (st === 'paid') return 'PAID'
+    if (st === 'void') return 'VOID'
+    if (st === 'refunded') return 'REFUNDED'
+    if (Number(totals && totals.amount_due || 0) <= 0 && Number(totals && totals.total || 0) > 0) return 'PAID'
+    return 'UNPAID'
+  }
+
+  function payMethodText(inv) {
+    var m = String(inv && inv.payment_method || '').trim()
+    var note = String(inv && inv.payment_method_note || '').trim()
+    if (!m && !note) return ''
+    if (!m) return note
+    if (!note) return m
+    return m + ' - ' + note
+  }
+
   function normalizeData(data) {
     var inv = data && data.invoice ? data.invoice : {}
     var company = data && data.company ? data.company : {}
@@ -69,6 +127,18 @@
   function renderClassic(data) {
     var d = normalizeData(data)
     var inv = d.inv, company = d.company, items = d.items, totals = d.totals
+    var invType = String(inv && inv.invoice_type || 'invoice')
+    var titleText = invType === 'quote' ? 'QUOTE' : (invType === 'receipt' ? 'RECEIPT' : 'INVOICE')
+    var noLabel = invType === 'quote' ? 'QUOTE #' : (invType === 'receipt' ? 'RECEIPT #' : 'INVOICE #')
+    var dateLabel = invType === 'receipt' ? 'Paid date' : 'Date'
+    var thirdLabel = invType === 'quote' ? 'Valid until' : (invType === 'receipt' ? 'Paid via' : 'Due date')
+    var thirdValue = invType === 'quote'
+      ? ((inv.valid_until || '').slice(0, 10) || '-')
+      : (invType === 'receipt'
+        ? (payMethodText(inv) || '-')
+        : ((inv.due_date || '').slice(0, 10) || '-'))
+    var amountLabel = invType === 'receipt' ? 'Amount Received' : (invType === 'quote' ? 'Total' : 'Amount Due')
+    var amountValue = invType === 'invoice' ? totals.amount_due : totals.total
 
     var addr = [
       company.address_line1,
@@ -77,16 +147,31 @@
       company.address_country
     ].filter(Boolean).join('\n')
 
+    var companyLines = []
+    if (company.legal_name) companyLines.push(String(company.legal_name))
+    if (addr) {
+      var addrLines = String(addr).split('\n').map(function (s) { return String(s || '').trim() }).filter(Boolean)
+      companyLines = companyLines.concat(addrLines)
+    }
+    if (company.phone) companyLines.push(String(company.phone))
+    if (company.email) companyLines.push(String(company.email))
+    if (company.abn) companyLines.push('ABN: ' + String(company.abn))
+    var companyHtml = companyLines.length
+      ? companyLines.map(function (s) { return '<div class="company-line">' + escapeHtml(s) + '</div>' }).join('')
+      : '<div class="company-line">-</div>'
+
     var billTo = [
       inv.bill_to_name,
       inv.bill_to_address,
+      inv.bill_to_phone,
+      inv.bill_to_abn ? ('ABN: ' + inv.bill_to_abn) : null,
       inv.bill_to_email
     ].filter(Boolean).join('\n')
 
     var rows = items.map(function (x) {
       return (
         '<tr>' +
-        '<td class="desc">' + escapeHtml(x.description || '-') + '</td>' +
+        '<td class="desc">' + renderItemDescHtml(x.description) + '</td>' +
         '<td class="nowrap num">' + escapeHtml(String(x.quantity == null ? '' : x.quantity)) + '</td>' +
         '<td class="nowrap num">$' + escapeHtml(formatMoney(x.unit_price || 0)) + '</td>' +
         '<td class="nowrap num">$' + escapeHtml(formatMoney(x.line_total || 0)) + '</td>' +
@@ -115,18 +200,12 @@
       watermark +
       '<div class="inv-header">' +
       '<div class="inv-logo">' +
-      (company.logo_url ? ('<img alt="logo" src="' + escapeHtml(company.logo_url) + '"/>') : '') +
+      (company.logo_url ? ('<img alt="logo" crossorigin="anonymous" referrerpolicy="no-referrer" src="' + escapeHtml(company.logo_url) + '"/>') : '') +
       '</div>' +
       '<div class="inv-title">' +
-      '<h1>INVOICE</h1>' +
+      '<h1>' + escapeHtml(titleText) + '</h1>' +
       '<div style="margin-top:6px"><span class="' + badgeCls + '">' + escapeHtml(String(st).toUpperCase()) + '</span></div>' +
-      '<div class="company">' +
-      escapeHtml(company.legal_name || '') + '\n' +
-      escapeHtml(addr) + '\n' +
-      (company.phone ? escapeHtml(company.phone) + '\n' : '') +
-      (company.email ? escapeHtml(company.email) + '\n' : '') +
-      'ABN : ' + escapeHtml(company.abn || '') +
-      '</div>' +
+      '<div class="company">' + companyHtml + '</div>' +
       '</div>' +
       '</div>' +
       '<div class="inv-band">' +
@@ -136,9 +215,9 @@
       '</div>' +
       '<div>' +
       '<div class="meta">' +
-      '<div class="k">INVOICE #</div><div class="v">' + escapeHtml(inv.invoice_no || '-') + '</div>' +
-      '<div class="k">Date</div><div class="v">' + escapeHtml((inv.issue_date || '').slice(0, 10) || '-') + '</div>' +
-      '<div class="k">Due date</div><div class="v">' + escapeHtml((inv.due_date || '').slice(0, 10) || '-') + '</div>' +
+      '<div class="k">' + escapeHtml(noLabel) + '</div><div class="v">' + escapeHtml(inv.invoice_no || '-') + '</div>' +
+      '<div class="k">' + escapeHtml(dateLabel) + '</div><div class="v">' + escapeHtml((inv.issue_date || '').slice(0, 10) || '-') + '</div>' +
+      (invType === 'receipt' ? '' : ('<div class="k">' + escapeHtml(thirdLabel) + '</div><div class="v">' + escapeHtml(thirdValue) + '</div>')) +
       '</div>' +
       '</div>' +
       '</div>' +
@@ -156,22 +235,26 @@
       '</table>' +
       '<div class="inv-footer-grid">' +
       '<div class="inv-placeholder"></div>' +
-      '<div>' +
+      '<div class="inv-footer-right">' +
+      '<div class="inv-card inv-summary-card">' +
       '<table class="inv-summary">' +
       '<tr><td>Subtotal</td><td>$' + escapeHtml(formatMoney(totals.subtotal)) + '</td></tr>' +
-      '<tr><td>TAX included(10%)</td><td>$' + escapeHtml(formatMoney(totals.tax_total)) + '</td></tr>' +
+      (invType === 'invoice' ? ('<tr><td>' + escapeHtml(gstLabel(items)) + '</td><td>$' + escapeHtml(formatMoney(totals.tax_total)) + '</td></tr>') : '') +
       '<tr><td class="strong">Total</td><td class="strong">$' + escapeHtml(formatMoney(totals.total)) + '</td></tr>' +
       '</table>' +
       '<div class="inv-amount-due">' +
-      '<div class="label">Amount Due</div>' +
-      '<div class="value">$' + escapeHtml(formatMoney(totals.amount_due)) + '<span class="cur">' + escapeHtml(inv.currency || 'AUD') + '</span></div>' +
+      '<div class="label">' + escapeHtml(amountLabel) + '</div>' +
+      '<div class="value">$' + escapeHtml(formatMoney(amountValue)) + '<span class="cur">' + escapeHtml(inv.currency || 'AUD') + '</span><div class="inv-pay-status">' + escapeHtml(payStatus(inv, totals)) + '</div>' +
+      ((invType === 'invoice' && payMethodText(inv)) ? ('<div class="inv-pay-method">' + escapeHtml(payMethodText(inv)) + '</div>') : '') +
+      '</div>' +
       '</div>' +
       '</div>' +
       '</div>' +
-      '<div class="inv-card inv-payment-bottom">' +
-      '<h3>Payment Instructions</h3>' +
... (diff truncated) ...
```

### 新增 frontend/src/app/finance/invoices/InvoicesCenter.module.css

- 变更类型: 新增
- 路径: frontend/src/app/finance/invoices/InvoicesCenter.module.css
- 关联单号: 未提供

```diff
diff --git a/frontend/src/app/finance/invoices/InvoicesCenter.module.css b/frontend/src/app/finance/invoices/InvoicesCenter.module.css
new file mode 100644
index 0000000..d6b2a1b
--- /dev/null
+++ b/frontend/src/app/finance/invoices/InvoicesCenter.module.css
@@ -0,0 +1,8 @@
+.invoiceCenterCard :global(.ant-card-head .ant-tabs-tab) {
+  font-size: 14px;
+}
+
+.invoiceCenterCard :global(.ant-card-head .ant-tabs-tab-btn) {
+  font-weight: 400;
+}
+

```

### 新增 frontend/src/app/finance/invoices/InvoicesCenterClient.tsx

- 变更类型: 新增
- 路径: frontend/src/app/finance/invoices/InvoicesCenterClient.tsx
- 关联单号: 未提供

```diff
diff --git a/frontend/src/app/finance/invoices/InvoicesCenterClient.tsx b/frontend/src/app/finance/invoices/InvoicesCenterClient.tsx
new file mode 100644
index 0000000..889a58a
--- /dev/null
+++ b/frontend/src/app/finance/invoices/InvoicesCenterClient.tsx
@@ -0,0 +1,266 @@
+"use client"
+
+import { useEffect, useMemo, useState } from 'react'
+import { App, Button, Card, DatePicker, Grid, Input, Modal, Select, Space, Table, Tag } from 'antd'
+import type { ColumnsType } from 'antd/es/table'
+import dayjs from 'dayjs'
+import Link from 'next/link'
+import { useRouter, useSearchParams } from 'next/navigation'
+import { API_BASE, authHeaders, getJSON, postJSON } from '../../../lib/api'
+import { hasPerm } from '../../../lib/auth'
+import { InvoiceCompaniesManager } from '../../../components/invoice/InvoiceCompaniesManager'
+import { InvoiceCustomersManager } from '../../../components/invoice/InvoiceCustomersManager'
+import styles from './InvoicesCenter.module.css'
+
+type Company = {
+  id: string
+  code?: string
+  legal_name: string
+  abn: string
+  is_default?: boolean
+}
+
+type Invoice = {
+  id: string
+  company_id: string
+  invoice_no?: string
+  status?: string
+  issue_date?: string
+  due_date?: string
+  currency?: string
+  bill_to_name?: string
+  bill_to_email?: string
+  total?: number
+  amount_due?: number
+  created_at?: string
+}
+
+function fmtMoney(n: any) {
+  const x = Number(n || 0)
+  const v = Number.isFinite(x) ? x : 0
+  return `$${v.toFixed(2)}`
+}
+
+function statusTag(s: string) {
+  const v = String(s || 'draft')
+  if (v === 'draft') return <Tag>draft</Tag>
+  if (v === 'issued') return <Tag color="blue">issued</Tag>
+  if (v === 'sent') return <Tag color="gold">sent</Tag>
+  if (v === 'paid') return <Tag color="green">paid</Tag>
+  if (v === 'void') return <Tag color="red">void</Tag>
+  if (v === 'refunded') return <Tag color="purple">refunded</Tag>
+  return <Tag>{v}</Tag>
+}
+
+export default function InvoicesCenterClient() {
+  const { message } = App.useApp()
+  const screens = Grid.useBreakpoint()
+  const isMobile = !screens.md
+  const router = useRouter()
+  const searchParams = useSearchParams()
+  const initialTab = String(searchParams.get('tab') || 'records')
+  const [activeTab, setActiveTab] = useState<string>(initialTab)
+
+  const [companies, setCompanies] = useState<Company[]>([])
+  const [invoices, setInvoices] = useState<Invoice[]>([])
+  const [loading, setLoading] = useState(false)
+  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<string[]>([])
+  const [filterCompany, setFilterCompany] = useState<string>('')
+  const [filterStatus, setFilterStatus] = useState<string>('')
+  const [filterRange, setFilterRange] = useState<any>(null)
+
+  useEffect(() => {
+    setActiveTab(String(searchParams.get('tab') || 'records'))
+  }, [searchParams])
+
+  const tabList = useMemo(() => ([
+    { key: 'records', tab: '开票记录' },
+    { key: 'companies', tab: '开票主体管理' },
+    { key: 'customers', tab: '常用客户管理' },
+  ]), [])
+
+  function setTabAndSyncUrl(k: string) {
+    setActiveTab(k)
+    const qs = new URLSearchParams(searchParams.toString())
+    if (k === 'records') qs.delete('tab')
+    else qs.set('tab', k)
+    router.replace(`/finance/invoices${qs.toString() ? `?${qs.toString()}` : ''}`)
+  }
+
+  const companyOptions = useMemo(() => companies.map(c => ({ value: c.id, label: `${c.code || 'INV'} · ${c.legal_name} (${c.abn})` })), [companies])
+  const companyById = useMemo(() => {
+    const m: Record<string, Company> = {}
+    companies.forEach(c => { m[String(c.id)] = c })
+    return m
+  }, [companies])
+
+  async function loadCompanies() {
+    try {
+      const rows = await getJSON<Company[]>('/invoices/companies')
+      setCompanies(rows || [])
+      const def = (rows || []).find(x => x.is_default)
+      if (def && !filterCompany) setFilterCompany(def.id)
+    } catch {
+    }
+  }
+
+  async function loadInvoices() {
+    setLoading(true)
+    try {
+      const params: any = {}
+      if (filterCompany) params.company_id = filterCompany
+      if (filterStatus) params.status = filterStatus
+      if (filterRange && filterRange[0] && filterRange[1]) {
+        params.from = dayjs(filterRange[0]).format('YYYY-MM-DD')
+        params.to = dayjs(filterRange[1]).format('YYYY-MM-DD')
+      }
+      const qs = new URLSearchParams(params).toString()
+      const rows = await getJSON<Invoice[]>(`/invoices${qs ? `?${qs}` : ''}`)
+      setInvoices(rows || [])
+      setSelectedInvoiceIds([])
+    } catch (e: any) {
+      message.error(String(e?.message || '加载失败'))
+    } finally {
+      setLoading(false)
+    }
+  }
+
+  async function mergeExportSelected() {
+    if (!selectedInvoiceIds.length) { message.error('请选择要合并导出的发票'); return }
+    try {
+      const res = await fetch(`${API_BASE}/invoices/merge-pdf`, {
+        method: 'POST',
+        headers: { 'Content-Type': 'application/json', ...authHeaders() },
+        body: JSON.stringify({ invoice_ids: selectedInvoiceIds })
+      })
+      if (!res.ok) throw new Error(`HTTP ${res.status}`)
+      const blob = await res.blob()
+      const url = URL.createObjectURL(blob)
+      const a = document.createElement('a')
+      a.href = url
+      a.download = `invoices_merged_${dayjs().format('YYYYMMDD_HHmm')}.pdf`
+      document.body.appendChild(a)
+      a.click()
+      a.remove()
+      URL.revokeObjectURL(url)
+      message.success('已导出')
+    } catch (e: any) {
+      message.error(String(e?.message || '导出失败'))
+    }
+  }
+
+  useEffect(() => {
+    loadCompanies().then(() => {})
+  }, [])
+
+  useEffect(() => {
+    if (!companies.length) return
+    loadInvoices().then(() => {})
+  }, [companies.length])
+
+  const columns: ColumnsType<Invoice> = [
+    { title: '单号', dataIndex: 'invoice_no', width: 160, render: (v) => v || '-' },
+    { title: '公司', dataIndex: 'company_id', width: 240, render: (v) => {
+      const c = companyById[String(v)]
+      return c ? `${c.code || 'INV'} · ${c.legal_name}` : String(v || '')
+    }},
+    { title: '状态', dataIndex: 'status', width: 120, render: (v) => statusTag(String(v || 'draft')) },
+    { title: '开票日', dataIndex: 'issue_date', width: 120, render: (v) => v ? String(v).slice(0,10) : '-' },
+    { title: '到期日', dataIndex: 'due_date', width: 120, render: (v) => v ? String(v).slice(0,10) : '-' },
+    { title: '收件人', dataIndex: 'bill_to_name', width: 180, render: (v, r) => v || r.bill_to_email || '-' },
+    { title: '总计', dataIndex: 'total', width: 120, align: 'right', render: (v) => fmtMoney(v) },
+    { title: '未收', dataIndex: 'amount_due', width: 120, align: 'right', render: (v) => fmtMoney(v) },
+    { title: '操作', key: 'act', width: 220, render: (_: any, r) => {
+      const st = String(r.status || 'draft')
+      const canVoid = hasPerm('invoice.void') && st !== 'refunded'
+      return (
+        <Space size={8}>
+          <Button size="small" shape="round" onClick={() => router.push(`/finance/invoices/${r.id}/preview`)}>查看</Button>
+          <Button size="small" shape="round" onClick={() => router.push(`/finance/invoices/${r.id}`)}>编辑</Button>
+          <Button
+            size="small"
+            shape="round"
+            danger
+            disabled={!canVoid}
+            onClick={() => {
+              let reason = '用户删除'
+              Modal.confirm({
+                title: '确认删除',
+                okText: '删除',
+                okType: 'danger',
+                cancelText: '取消',
+                content: (
+                  <div style={{ display:'grid', gap: 10 }}>
+                    <div style={{ color:'rgba(17,24,39,0.65)' }}>将把该记录标记为 void（作废），不可撤销。</div>
... (diff truncated) ...
```

### 修改 frontend/src/app/finance/invoices/[id]/preview/page.tsx

- 变更类型: 修改
- 路径: frontend/src/app/finance/invoices/[id]/preview/page.tsx
- 关联单号: 未提供

```diff
diff --git a/frontend/src/app/finance/invoices/[id]/preview/page.tsx b/frontend/src/app/finance/invoices/[id]/preview/page.tsx
index e2271c7..331ebfe 100644
--- a/frontend/src/app/finance/invoices/[id]/preview/page.tsx
+++ b/frontend/src/app/finance/invoices/[id]/preview/page.tsx
@@ -7,7 +7,7 @@ import { useRouter } from 'next/navigation'
 import html2canvas from 'html2canvas'
 import { jsPDF } from 'jspdf'
 import { getJSON } from '../../../../../lib/api'
-import { buildInvoiceTemplateHtml } from '../../../../../lib/invoiceTemplateHtml'
+import { buildInvoiceTemplateHtml, normalizeAssetUrl } from '../../../../../lib/invoiceTemplateHtml'
 
 export default function InvoicePreviewPage({ params }: { params: { id: string } }) {
   const router = useRouter()
@@ -20,11 +20,77 @@ export default function InvoicePreviewPage({ params }: { params: { id: string }
   const [loading, setLoading] = useState(true)
   const iframeRef = useRef<HTMLIFrameElement | null>(null)
 
+  function isR2Url(u: string) {
+    try {
+      const url = new URL(u)
+      const host = String(url.hostname || '').toLowerCase()
+      return host.endsWith('.r2.dev') || host.includes('r2.cloudflarestorage.com')
+    } catch {
+      return false
+    }
+  }
+
+  async function tryFetchDataUrl(url: string) {
+    const u = String(url || '').trim()
+    if (!u) return null
+    if (u.startsWith('data:')) return u
+    try {
+      const resp = await fetch(u, { credentials: 'include' })
+      if (!resp.ok) return null
+      const blob = await resp.blob()
+      const dataUrl: string = await new Promise((resolve, reject) => {
+        const reader = new FileReader()
+        reader.onload = () => resolve(String(reader.result || ''))
+        reader.onerror = () => reject(new Error('read_logo_failed'))
+        reader.readAsDataURL(blob)
+      })
+      if (!String(dataUrl || '').startsWith('data:')) return null
+      return dataUrl
+    } catch {
+      return null
+    }
+  }
+
+  async function waitForIframeAssets(doc: Document) {
+    try {
+      const fonts: any = (doc as any).fonts
+      if (fonts?.ready) {
+        await Promise.race([fonts.ready, new Promise((r) => setTimeout(r, 1500))])
+      }
+    } catch {}
+    try {
+      const imgs = Array.from(doc.images || [])
+      const loaders = imgs.map((img) => {
+        if (img.complete) return Promise.resolve()
+        return new Promise<void>((resolve) => {
+          const done = () => {
+            img.removeEventListener('load', done)
+            img.removeEventListener('error', done)
+            resolve()
+          }
+          img.addEventListener('load', done)
+          img.addEventListener('error', done)
+        })
+      })
+      await Promise.race([Promise.all(loaders), new Promise((r) => setTimeout(r, 4000))])
+    } catch {}
+  }
+
   useEffect(() => {
     if (!id) return
     setLoading(true)
     getJSON<any>(`/invoices/${id}`)
-      .then((j) => { setInvoice(j); })
+      .then(async (j) => {
+        const next = { ...(j || {}), company: { ...(j?.company || {}) } }
+        const logo = String(next.company?.logo_url || '').trim()
+        if (logo) {
+          const abs = normalizeAssetUrl(logo)
+          const proxied = isR2Url(abs) ? `${normalizeAssetUrl('/public/r2-image')}?url=${encodeURIComponent(abs)}` : abs
+          const inlined = await tryFetchDataUrl(proxied)
+          next.company.logo_url = inlined || proxied
+        }
+        setInvoice(next)
+      })
       .catch((e: any) => message.error(String(e?.message || '加载失败')))
       .finally(() => setLoading(false))
   }, [id])
@@ -37,88 +103,113 @@ export default function InvoicePreviewPage({ params }: { params: { id: string }
 
   async function doPrint() {
     try {
+      const doc = iframeRef.current?.contentDocument
+      if (!doc) { message.error('打印失败'); return }
+      const printCss = `
+        @media print {
+          .inv-header { grid-template-columns: 1fr 1fr !important; gap: 16px !important; }
+          .inv-title { text-align: right !important; }
+          .inv-band { grid-template-columns: 1fr 1fr !important; }
+          .inv-footer-grid { grid-template-columns: 1fr 0.9fr !important; }
+        }
+      `
       const win = iframeRef.current?.contentWindow
       if (!win) return
       win.focus()
-      win.print()
+      await withTempStyle(doc, 'inv-print-style', printCss, async () => {
+        await waitForIframeAssets(doc)
+        win.print()
+      })
     } catch {
       message.error('打印失败')
     }
   }
 
-  async function capturePng(params: { label: string; injectStyleText?: string }) {
-    const doc = iframeRef.current?.contentDocument
-    if (!doc) throw new Error('missing_iframe')
-    const styleId = 'inv-capture-style'
-    const prev = doc.getElementById(styleId)
+  async function withTempStyle<T>(doc: Document, id: string, cssText: string, fn: () => Promise<T>): Promise<T> {
+    const prev = doc.getElementById(id)
     if (prev) prev.remove()
-    if (params.injectStyleText) {
-      const st = doc.createElement('style')
-      st.id = styleId
-      st.textContent = params.injectStyleText
-      doc.head.appendChild(st)
-    }
-    await new Promise(r => setTimeout(r, 50))
-    const canvas = await html2canvas(doc.body, { scale: 2, backgroundColor: '#ffffff', useCORS: true })
-    const blob: Blob = await new Promise((resolve, reject) => {
-      canvas.toBlob((b) => b ? resolve(b) : reject(new Error('toBlob_failed')), 'image/png')
-    })
-    const url = URL.createObjectURL(blob)
-    const a = document.createElement('a')
-    a.href = url
-    a.download = `invoice_${invoice?.invoice_no || id}_${params.label}_${dayjs().format('YYYYMMDD_HHmm')}.png`.replace(/[^\w\-\.]+/g, '_')
-    document.body.appendChild(a)
-    a.click()
-    a.remove()
-    URL.revokeObjectURL(url)
-    if (params.injectStyleText) {
-      const now = doc.getElementById(styleId)
-      if (now) now.remove()
-    }
-  }
-
-  async function downloadCompare() {
+    const st = doc.createElement('style')
+    st.id = id
+    st.textContent = cssText
+    doc.head.appendChild(st)
     try {
-      if (!invoice) return
-      const beforeStyle = `
-        html, body { font-size: 10px !important; font-weight: 300 !important; }
-        .inv-title h1 { font-size: 16px !important; font-weight: 600 !important; }
-        .inv-band .meta .v { font-size: 12px !important; font-weight: 500 !important; }
-        .inv-table { font-size: 10px !important; }
-        .inv-summary td:last-child { font-size: 12px !important; }
-        .inv-amount-due .value { font-size: 18px !important; }
-      `
-      await capturePng({ label: 'before', injectStyleText: beforeStyle })
-      await capturePng({ label: 'after' })
-      message.success('对比图已下载')
-    } catch (e: any) {
-      message.error(String(e?.message || '导出失败'))
+      return await fn()
+    } finally {
+      try { st.remove() } catch {}
     }
   }
 
   async function exportPdf() {
+    const key = 'invoice-export-pdf'
+    message.loading({ content: '正在生成 PDF…', key, duration: 0 })
     try {
       const doc = iframeRef.current?.contentDocument
-      if (!doc) return
-      const body = doc.body
-      const canvas = await html2canvas(body, { scale: 2, backgroundColor: '#ffffff', useCORS: true })
-      const imgData = canvas.toDataURL('image/jpeg', 0.92)
-      const pdf = new jsPDF('p', 'mm', 'a4')
-      const pageW = 210
-      const pageH = 297
-      const imgW = pageW
-      const imgH = canvas.height * (imgW / canvas.width)
-      let y = 0
-      let remaining = imgH
-      while (remaining > 0) {
-        pdf.addImage(imgData, 'JPEG', 0, y, imgW, imgH)
-        remaining -= pageH
-        if (remaining > 0) { pdf.addPage(); y -= pageH }
+      if (!doc) throw new Error('missing_iframe')
+      const target = (doc.querySelector('.inv-sheet') as HTMLElement | null) || doc.body
... (diff truncated) ...
```

### 修改 frontend/src/app/finance/invoices/_components/InvoiceEditor.tsx

- 变更类型: 修改
- 路径: frontend/src/app/finance/invoices/_components/InvoiceEditor.tsx
- 关联单号: 未提供

```diff
diff --git a/frontend/src/app/finance/invoices/_components/InvoiceEditor.tsx b/frontend/src/app/finance/invoices/_components/InvoiceEditor.tsx
index 0466cef..4b8c0a5 100644
--- a/frontend/src/app/finance/invoices/_components/InvoiceEditor.tsx
+++ b/frontend/src/app/finance/invoices/_components/InvoiceEditor.tsx
@@ -1,13 +1,15 @@
 "use client"
 
 import { useEffect, useMemo, useRef, useState } from 'react'
-import { App, Button, Card, Col, Collapse, DatePicker, Divider, Form, Grid, Input, InputNumber, Modal, Row, Select, Space, Steps, Table, Tag } from 'antd'
+import { App, Button, Card, Checkbox, Col, Collapse, DatePicker, Divider, Form, Grid, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Steps, Table, Tag, Tooltip } from 'antd'
 import type { ColumnsType } from 'antd/es/table'
 import dayjs from 'dayjs'
 import { useRouter } from 'next/navigation'
+import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
 import { API_BASE, authHeaders, getJSON, patchJSON, postJSON } from '../../../../lib/api'
 import { hasPerm } from '../../../../lib/auth'
-import { canBackendAutosaveDraft, computeLine, computeTotals, extractDiscount, normalizeLineItemsForSave, stableHash, type GstType, type InvoiceLineItemInput } from '../../../../lib/invoiceEditorModel'
+import { buildInvoicePayload } from '../../../../lib/invoicePayload'
+import { canBackendAutosaveDraft, computeLine, computeTotals, extractDiscount, normalizeLineItemsForSave, stableHash, type GstType } from '../../../../lib/invoiceEditorModel'
 import styles from './InvoiceEditor.module.css'
 
 type Company = {
@@ -36,14 +38,22 @@ type Company = {
 type InvoiceDetail = {
   id: string
   company_id: string
+  invoice_type?: string
   invoice_no?: string
   status?: string
   issue_date?: string
   due_date?: string
+  valid_until?: string
   currency?: string
+  customer_id?: string
   bill_to_name?: string
   bill_to_email?: string
+  bill_to_phone?: string
+  bill_to_abn?: string
   bill_to_address?: string
+  payment_method?: string
+  payment_method_note?: string
+  paid_at?: string
   notes?: string
   terms?: string
   subtotal?: number
@@ -79,11 +89,31 @@ function normalizeDraftDates(values: any) {
   const v = { ...(values || {}) }
   const a = v.issue_date
   const b = v.due_date
+  const c = v.valid_until
   if (typeof a === 'string' && a) v.issue_date = dayjs(a)
   if (typeof b === 'string' && b) v.due_date = dayjs(b)
+  if (typeof c === 'string' && c) v.valid_until = dayjs(c)
   return v
 }
 
+function splitItemDesc(raw: any) {
+  const s0 = String(raw || '').replace(/\r\n/g, '\n').trim()
+  if (!s0) return { title: '', content: '' }
+  const parts = s0.split('\n')
+  const title = String(parts.shift() || '').trim()
+  const content = parts.join('\n').trim()
+  return { title, content }
+}
+
+function joinItemDesc(title: any, content: any) {
+  const t = String(title || '').trim()
+  const c = String(content || '').trim()
+  if (!t && !c) return ''
+  if (!c) return t
+  if (!t) return c
+  return `${t}\n${c}`
+}
+
 export function InvoiceEditor(props: { mode: 'new' | 'edit'; invoiceId?: string }) {
   const { mode } = props
   const router = useRouter()
@@ -97,13 +127,31 @@ export function InvoiceEditor(props: { mode: 'new' | 'edit'; invoiceId?: string
   const [autosaving, setAutosaving] = useState(false)
   const [invoiceId, setInvoiceId] = useState<string | null>(props.invoiceId || null)
   const [invoice, setInvoice] = useState<InvoiceDetail | null>(null)
+  const status = String(invoice?.status || 'draft')
+  const lineItemsLocked = mode === 'edit' && status !== 'draft'
   const [discountAmount, setDiscountAmount] = useState<number>(0)
+  const [savedCustomers, setSavedCustomers] = useState<Array<{ id: string; name?: string; email?: string; phone?: string; abn?: string; address?: string }>>([])
+  const [selectedCustomerId, setSelectedCustomerId] = useState<string | undefined>(undefined)
+  const [saveAsCommonCustomer, setSaveAsCommonCustomer] = useState(false)
   const [auditRows, setAuditRows] = useState<any[]>([])
   const [sendLogs, setSendLogs] = useState<any[]>([])
+  const [paymentEvents, setPaymentEvents] = useState<any[]>([])
   const [formVersion, setFormVersion] = useState(0)
 
   const [form] = Form.useForm()
   const lastSavedHashRef = useRef<string>('')
+  const lineItems = Form.useWatch('line_items', form) as any[] | undefined
+  const invoiceType = String(Form.useWatch('invoice_type', form) || 'invoice')
+  const watchedIssueDate = Form.useWatch('issue_date', form)
+  const watchedValidUntil = Form.useWatch('valid_until', form)
+  const canSwitchInvoiceType = hasPerm('invoice.type.switch')
+  const [itemModalOpen, setItemModalOpen] = useState(false)
+  const [itemModalIndex, setItemModalIndex] = useState<number | null>(null)
+  const [itemModalForm] = Form.useForm()
+  function setLineItems(next: any[]) {
+    form.setFieldsValue({ line_items: next })
+    setFormVersion(v => v + 1)
+  }
 
   const companyOptions = useMemo(() => companies.map(c => ({ value: c.id, label: `${c.code || 'INV'} · ${c.legal_name} (${c.abn})` })), [companies])
   const companyById = useMemo(() => {
@@ -120,6 +168,23 @@ export function InvoiceEditor(props: { mode: 'new' | 'edit'; invoiceId?: string
     }
   }
 
+  async function loadSavedCustomers() {
+    try {
+      const rows = await getJSON<any[]>('/invoices/customers')
+      const list = Array.isArray(rows) ? rows : []
+      setSavedCustomers(list.filter((x: any) => String(x?.status || 'active') === 'active').map((x: any) => ({
+        id: String(x?.id || ''),
+        name: String(x?.name || '') || undefined,
+        email: String(x?.email || '') || undefined,
+        phone: String(x?.phone || '') || undefined,
+        abn: String(x?.abn || '') || undefined,
+        address: String(x?.address || '') || undefined,
+      })).filter((x: any) => x.id))
+    } catch {
+      setSavedCustomers([])
+    }
+  }
+
   async function loadInvoice(id: string) {
     setLoading(true)
     try {
@@ -129,13 +194,20 @@ export function InvoiceEditor(props: { mode: 'new' | 'edit'; invoiceId?: string
       setDiscountAmount(Number(extracted.discount_amount || 0))
       form.setFieldsValue({
         company_id: j.company_id,
+        invoice_type: j.invoice_type || 'invoice',
         currency: j.currency || 'AUD',
         invoice_no: j.invoice_no || '',
         issue_date: j.issue_date ? dayjs(j.issue_date) : null,
         due_date: j.due_date ? dayjs(j.due_date) : null,
+        valid_until: j.valid_until ? dayjs(j.valid_until) : null,
+        customer_id: j.customer_id || '',
         bill_to_name: j.bill_to_name || '',
         bill_to_email: j.bill_to_email || '',
+        bill_to_phone: j.bill_to_phone || '',
+        bill_to_abn: j.bill_to_abn || '',
         bill_to_address: j.bill_to_address || '',
+        payment_method: j.payment_method || '',
+        payment_method_note: j.payment_method_note || '',
         notes: j.notes || '',
         terms: j.terms || '',
         line_items: (extracted.user_items || []).map((x: any) => ({
@@ -145,6 +217,8 @@ export function InvoiceEditor(props: { mode: 'new' | 'edit'; invoiceId?: string
           gst_type: (x.gst_type || 'GST_10') as GstType,
         })),
       })
+      setSelectedCustomerId(j.customer_id ? String(j.customer_id) : undefined)
+      setSaveAsCommonCustomer(false)
       const base = form.getFieldsValue(true)
       lastSavedHashRef.current = stableHash({ ...base, discountAmount: Number(extracted.discount_amount || 0) })
       try {
@@ -198,27 +272,51 @@ export function InvoiceEditor(props: { mode: 'new' | 'edit'; invoiceId?: string
     }
   }
 
-  function buildPayload(values: any) {
-    const userItems = (values.line_items || []) as InvoiceLineItemInput[]
-    const items = normalizeLineItemsForSave({ user_items: userItems, discount_amount: discountAmount })
-    return {
-      company_id: values.company_id,
-      currency: values.currency || 'AUD',
-      bill_to_name: values.bill_to_name || undefined,
-      bill_to_email: values.bill_to_email || undefined,
-      bill_to_address: values.bill_to_address || undefined,
-      notes: values.notes || undefined,
-      terms: values.terms || undefined,
-      issue_date: values.issue_date ? dayjs(values.issue_date).format('YYYY-MM-DD') : undefined,
-      due_date: values.due_date ? dayjs(values.due_date).format('YYYY-MM-DD') : undefined,
-      line_items: items.map((x) => ({ description: x.description, quantity: Number(x.quantity), unit_price: Number(x.unit_price), gst_type: x.gst_type })),
+  async function loadPaymentHistory(id: string) {
+    try {
+      const rows = await getJSON<any[]>(`/invoices/${id}/payment-history`)
+      setPaymentEvents(Array.isArray(rows) ? rows : [])
+    } catch {
+      setPaymentEvents([])
+    }
+  }
+
+  function buildPayload(values: any, status: string) {
+    return buildInvoicePayload(values, status, discountAmount)
+  }
+
+  async function saveCustomerIfNeeded(params?: { silent?: boolean; fromAutosave?: boolean }) {
+    try {
+      if (!saveAsCommonCustomer) return null
+      if (params?.fromAutosave) return null
+      const name = String(form.getFieldValue('bill_to_name') || '').trim()
+      const email = String(form.getFieldValue('bill_to_email') || '').trim()
... (diff truncated) ...
```

### 修改 frontend/src/app/finance/invoices/page.tsx

- 变更类型: 修改
- 路径: frontend/src/app/finance/invoices/page.tsx
- 关联单号: 未提供

```diff
diff --git a/frontend/src/app/finance/invoices/page.tsx b/frontend/src/app/finance/invoices/page.tsx
index a9af015..7e064e8 100644
--- a/frontend/src/app/finance/invoices/page.tsx
+++ b/frontend/src/app/finance/invoices/page.tsx
@@ -1,185 +1,10 @@
-"use client"
-
-import { useEffect, useMemo, useState } from 'react'
-import { App, Button, Card, DatePicker, Grid, Select, Space, Table, Tag } from 'antd'
-import type { ColumnsType } from 'antd/es/table'
-import dayjs from 'dayjs'
-import Link from 'next/link'
-import { API_BASE, authHeaders, getJSON } from '../../../lib/api'
-
-type Company = {
-  id: string
-  code?: string
-  legal_name: string
-  abn: string
-  is_default?: boolean
-}
-
-type Invoice = {
-  id: string
-  company_id: string
-  invoice_no?: string
-  status?: string
-  issue_date?: string
-  due_date?: string
-  currency?: string
-  bill_to_name?: string
-  bill_to_email?: string
-  total?: number
-  amount_due?: number
-  created_at?: string
-}
-
-function fmtMoney(n: any) {
-  const x = Number(n || 0)
-  const v = Number.isFinite(x) ? x : 0
-  return `$${v.toFixed(2)}`
-}
-
-function statusTag(s: string) {
-  const v = String(s || 'draft')
-  if (v === 'draft') return <Tag>draft</Tag>
-  if (v === 'issued') return <Tag color="blue">issued</Tag>
-  if (v === 'sent') return <Tag color="gold">sent</Tag>
-  if (v === 'paid') return <Tag color="green">paid</Tag>
-  if (v === 'void') return <Tag color="red">void</Tag>
-  if (v === 'refunded') return <Tag color="purple">refunded</Tag>
-  return <Tag>{v}</Tag>
-}
+import { Suspense } from 'react'
+import InvoicesCenterClient from './InvoicesCenterClient'
 
 export default function InvoicesListPage() {
-  const { message } = App.useApp()
-  const screens = Grid.useBreakpoint()
-  const isMobile = !screens.md
-
-  const [companies, setCompanies] = useState<Company[]>([])
-  const [invoices, setInvoices] = useState<Invoice[]>([])
-  const [loading, setLoading] = useState(false)
-  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<string[]>([])
-  const [filterCompany, setFilterCompany] = useState<string>('')
-  const [filterStatus, setFilterStatus] = useState<string>('')
-  const [filterRange, setFilterRange] = useState<any>(null)
-
-  const companyOptions = useMemo(() => companies.map(c => ({ value: c.id, label: `${c.code || 'INV'} · ${c.legal_name} (${c.abn})` })), [companies])
-  const companyById = useMemo(() => {
-    const m: Record<string, Company> = {}
-    companies.forEach(c => { m[String(c.id)] = c })
-    return m
-  }, [companies])
-
-  async function loadCompanies() {
-    try {
-      const rows = await getJSON<Company[]>('/invoices/companies')
-      setCompanies(rows || [])
-      const def = (rows || []).find(x => x.is_default)
-      if (def && !filterCompany) setFilterCompany(def.id)
-    } catch {
-    }
-  }
-
-  async function loadInvoices() {
-    setLoading(true)
-    try {
-      const params: any = {}
-      if (filterCompany) params.company_id = filterCompany
-      if (filterStatus) params.status = filterStatus
-      if (filterRange && filterRange[0] && filterRange[1]) {
-        params.from = dayjs(filterRange[0]).format('YYYY-MM-DD')
-        params.to = dayjs(filterRange[1]).format('YYYY-MM-DD')
-      }
-      const qs = new URLSearchParams(params).toString()
-      const rows = await getJSON<Invoice[]>(`/invoices${qs ? `?${qs}` : ''}`)
-      setInvoices(rows || [])
-      setSelectedInvoiceIds([])
-    } catch (e: any) {
-      message.error(String(e?.message || '加载失败'))
-    } finally {
-      setLoading(false)
-    }
-  }
-
-  async function mergeExportSelected() {
-    if (!selectedInvoiceIds.length) { message.error('请选择要合并导出的发票'); return }
-    try {
-      const res = await fetch(`${API_BASE}/invoices/merge-pdf`, {
-        method: 'POST',
-        headers: { 'Content-Type': 'application/json', ...authHeaders() },
-        body: JSON.stringify({ invoice_ids: selectedInvoiceIds })
-      })
-      if (!res.ok) throw new Error(`HTTP ${res.status}`)
-      const blob = await res.blob()
-      const url = URL.createObjectURL(blob)
-      const a = document.createElement('a')
-      a.href = url
-      a.download = `invoices_merged_${dayjs().format('YYYYMMDD_HHmm')}.pdf`
-      document.body.appendChild(a)
-      a.click()
-      a.remove()
-      URL.revokeObjectURL(url)
-      message.success('已导出')
-    } catch (e: any) {
-      message.error(String(e?.message || '导出失败'))
-    }
-  }
-
-  useEffect(() => {
-    loadCompanies().then(() => {})
-  }, [])
-
-  useEffect(() => {
-    if (!companies.length) return
-    loadInvoices().then(() => {})
-  }, [companies.length])
-
-  const columns: ColumnsType<Invoice> = [
-    { title: '单号', dataIndex: 'invoice_no', width: 160, render: (v) => v || '-' },
-    { title: '公司', dataIndex: 'company_id', width: 240, render: (v) => {
-      const c = companyById[String(v)]
-      return c ? `${c.code || 'INV'} · ${c.legal_name}` : String(v || '')
-    }},
-    { title: '状态', dataIndex: 'status', width: 120, render: (v) => statusTag(String(v || 'draft')) },
-    { title: '开票日', dataIndex: 'issue_date', width: 120, render: (v) => v ? String(v).slice(0,10) : '-' },
-    { title: '到期日', dataIndex: 'due_date', width: 120, render: (v) => v ? String(v).slice(0,10) : '-' },
-    { title: '收件人', dataIndex: 'bill_to_name', width: 180, render: (v, r) => v || r.bill_to_email || '-' },
-    { title: '总计', dataIndex: 'total', width: 120, align: 'right', render: (v) => fmtMoney(v) },
-    { title: '未收', dataIndex: 'amount_due', width: 120, align: 'right', render: (v) => fmtMoney(v) },
-    { title: '操作', key: 'act', width: 140, render: (_: any, r) => (
-      <Link href={`/finance/invoices/${r.id}`} prefetch={false}>查看/编辑</Link>
-    )},
-  ]
-
   return (
-    <div style={{ background: '#F5F7FA', padding: 16, minHeight: 'calc(100vh - 64px)' }}>
-      <Card
-        title="发票中心"
-        extra={(
-          <Space wrap style={{ justifyContent: isMobile ? 'flex-start' : 'flex-end' }}>
-            <Select style={{ width: 260 }} allowClear placeholder="选择开票主体" value={filterCompany || undefined} options={companyOptions} onChange={(v) => setFilterCompany(String(v || ''))} />
-            <Select style={{ width: 140 }} allowClear placeholder="状态" value={filterStatus || undefined} options={[
-              { value: 'draft', label: 'draft' },
-              { value: 'issued', label: 'issued' },
-              { value: 'sent', label: 'sent' },
-              { value: 'paid', label: 'paid' },
-              { value: 'void', label: 'void' },
-              { value: 'refunded', label: 'refunded' },
-            ]} onChange={(v) => setFilterStatus(String(v || ''))} />
-            <DatePicker.RangePicker value={filterRange} onChange={(v) => setFilterRange(v)} />
-            <Button onClick={loadInvoices}>刷新</Button>
-            <Button onClick={mergeExportSelected} disabled={!selectedInvoiceIds.length}>合并导出</Button>
-            <Link href="/finance/invoices/new" prefetch={false}><Button type="primary">新建发票</Button></Link>
-          </Space>
-        )}
-      >
-        <Table
-          rowKey="id"
-          columns={columns}
-          dataSource={invoices}
-          loading={loading}
-          rowSelection={{ selectedRowKeys: selectedInvoiceIds, onChange: (keys) => setSelectedInvoiceIds(keys as any) }}
-          pagination={{ pageSize: 20 }}
-        />
-      </Card>
-    </div>
+    <Suspense fallback={<div style={{ padding: 16 }}>加载中...</div>}>
+      <InvoicesCenterClient />
+    </Suspense>
   )
 }
-

```

### 修改 frontend/src/app/finance/recurring/page.tsx

- 变更类型: 修改
- 路径: frontend/src/app/finance/recurring/page.tsx
- 关联单号: 未提供

```diff
diff --git a/frontend/src/app/finance/recurring/page.tsx b/frontend/src/app/finance/recurring/page.tsx
index c3e44a8..b1ccd66 100644
--- a/frontend/src/app/finance/recurring/page.tsx
+++ b/frontend/src/app/finance/recurring/page.tsx
@@ -31,6 +31,7 @@ export default function RecurringPage() {
   const [viewOpen, setViewOpen] = useState(false)
   const [viewing, setViewing] = useState<Recurring | null>(null)
   const [searchText, setSearchText] = useState('')
+  const [rowMutating, setRowMutating] = useState<Record<string, 'pay' | 'unpay' | undefined>>({})
 
   async function load() {
     const rows = await fetch(`${API_BASE}/crud/recurring_payments`, { headers: authHeaders() }).then(r=>r.json()).catch(()=>[])
@@ -126,66 +127,120 @@ export default function RecurringPage() {
         <Button onClick={()=>{ setViewing(r); setViewOpen(true) }}>查看</Button>
         <Button onClick={()=>{ const sm = (r as any).start_month_key ? dayjs.tz(`${String((r as any).start_month_key)}-01`, 'YYYY-MM-DD', 'Australia/Melbourne') : nowAU().startOf('month'); setEditing(r); setOpen(true); form.setFieldsValue({ ...r, start_month: sm, frequency_months: r.frequency_months ?? 1 }) }}>编辑</Button>
         {(r.payment_type === 'rent_deduction') ? null : (r.is_paid ? (
-          <Button onClick={async ()=>{
-            try {
+          <Popconfirm
+            title="确认标记为未付？"
+            okText="确认"
+            cancelText="取消"
+            onConfirm={async ()=>{
+              const id = String(r.id)
+              if (rowMutating[id]) return
               const monthKey = m.format('YYYY-MM')
-              const resType = (r.scope||'company')==='property' ? 'property_expenses' : 'company_expenses'
-              const qs = new URLSearchParams({ fixed_expense_id: String((r as any).fixed_expense_id || r.id), month_key: monthKey })
-              const listRes = await fetch(`${API_BASE}/crud/${resType}?${qs.toString()}`, { headers: authHeaders() })
-              const arr = listRes.ok ? await listRes.json().catch(()=>[]) : []
-              for (const it of Array.isArray(arr)?arr:[]) {
-                if (it?.id) await fetch(`${API_BASE}/crud/${resType}/${it.id}`, { method:'PATCH', headers: { 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify({ status:'unpaid', paid_date: null }) })
+              const fixedId = String((r as any).fixed_expense_id || r.id)
+              const prevExpenses = (expenses||[]).filter(e => String(e.month_key||'')===monthKey && String(e.fixed_expense_id||'')===fixedId)
+              setRowMutating(s => ({ ...s, [id]: 'unpay' }))
+              const msgKey = `unpay-${id}-${monthKey}`
+              message.open({ type:'loading', content:'正在切换为未付…', key: msgKey, duration: 0 })
+              setExpenses(prev => prev.map(e => (String(e.month_key||'')===monthKey && String(e.fixed_expense_id||'')===fixedId) ? ({ ...e, status:'unpaid', paid_date: null } as any) : e))
+              try {
+                const resType = (r.scope||'company')==='property' ? 'property_expenses' : 'company_expenses'
+                const qs = new URLSearchParams({ fixed_expense_id: fixedId, month_key: monthKey })
+                const listRes = await fetch(`${API_BASE}/crud/${resType}?${qs.toString()}`, { headers: authHeaders() })
+                const arr = listRes.ok ? await listRes.json().catch(()=>[]) : []
+                const rows = Array.isArray(arr) ? arr : []
+                await Promise.all(rows.filter((it:any)=>it?.id).map((it:any)=> fetch(`${API_BASE}/crud/${resType}/${it.id}`, { method:'PATCH', headers: { 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify({ status:'unpaid', paid_date: null }) })))
+                message.open({ type:'success', content:'已切换为未付', key: msgKey })
+                void refreshMonth()
+              } catch (e:any) {
+                setExpenses(prev => {
+                  const rest = prev.filter(e => !(String(e.month_key||'')===monthKey && String(e.fixed_expense_id||'')===fixedId))
+                  return [...rest, ...prevExpenses]
+                })
+                message.open({ type:'error', content:(e?.message || '切换失败'), key: msgKey })
+              } finally {
+                setRowMutating(s => ({ ...s, [id]: undefined }))
               }
-              message.success('已退回为未付')
-              await refreshMonth()
-            } catch (e:any) {
-              message.error(e?.message || '退回失败')
-            }
-          }}>未付</Button>
+            }}
+          >
+            <Button loading={rowMutating[String(r.id)]==='unpay'} disabled={!!rowMutating[String(r.id)]}>未付</Button>
+          </Popconfirm>
         ) : (
-          <Button onClick={async ()=>{
-            const todayISO = nowAU().format('YYYY-MM-DD')
-            const dueDay = Number(r.due_day_of_month || 1)
-            const freq = Number(r.frequency_months || 1)
-            try {
-              const resType = (r.scope||'company')==='property' ? 'property_expenses' : 'company_expenses'
-              for (let i = 0; i < freq; i++) {
-                const mm = m.add(i, 'month')
-                const dimi = mm.endOf('month').date()
-                const dueISOi = mm.startOf('month').date(Math.min(dueDay, dimi)).format('YYYY-MM-DD')
-                const monthKeyi = mm.format('YYYY-MM')
-                const qs = new URLSearchParams({ fixed_expense_id: String(r.id), month_key: monthKeyi })
-                const existingRes = await fetch(`${API_BASE}/crud/${resType}?${qs.toString()}`, { headers: authHeaders() })
-                let rows: any[] = []
-                if (existingRes.ok) {
-                  const arr = await existingRes.json().catch(()=>[])
-                  rows = Array.isArray(arr) ? arr : []
+          <Popconfirm
+            title="确认已付款并标记为已付？"
+            okText="确认"
+            cancelText="取消"
+            onConfirm={async ()=>{
+              const id = String(r.id)
+              if (rowMutating[id]) return
+              const todayISO = nowAU().format('YYYY-MM-DD')
+              const dueDay = Number(r.due_day_of_month || 1)
+              const freq = Number(r.frequency_months || 1)
+              const dim = m.endOf('month').date()
+              const dueISO = m.startOf('month').date(Math.min(dueDay, dim)).format('YYYY-MM-DD')
+              const monthKey = m.format('YYYY-MM')
+              const fixedId = String((r as any).fixed_expense_id || r.id)
+              const prevExpenses = (expenses||[]).filter(e => String(e.month_key||'')===monthKey && String(e.fixed_expense_id||'')===fixedId)
+              const prevTpl = (list||[]).find(x => String(x.id)===id)
+              setRowMutating(s => ({ ...s, [id]: 'pay' }))
+              const msgKey = `pay-${id}-${monthKey}`
+              message.open({ type:'loading', content:'正在标记已付…', key: msgKey, duration: 0 })
+              setExpenses(prev => {
+                const rest = prev.filter(e => !(String(e.month_key||'')===monthKey && String(e.fixed_expense_id||'')===fixedId))
+                const optimistic: ExpenseRow = {
+                  id: prevExpenses?.[0]?.id || `optimistic-${id}-${monthKey}`,
+                  fixed_expense_id: fixedId,
+                  month_key: monthKey,
+                  due_date: dueISO,
+                  paid_date: todayISO,
+                  status: 'paid',
+                  property_id: r.property_id,
+                  category: r.category,
+                  amount: Number(r.amount || 0),
                 }
-                if (rows.length === 0) {
-                  const bodyi = { occurred_at: todayISO, amount: Number(r.amount||0), currency: 'AUD', category: r.category || 'other', note: 'Fixed payment', generated_from: 'recurring_payments', fixed_expense_id: r.id, month_key: monthKeyi, due_date: dueISOi, paid_date: todayISO, status: 'paid', property_id: r.property_id }
-                  const resp = await fetch(`${API_BASE}/crud/${resType}`, { method:'POST', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(bodyi) })
-                  if (!resp.ok && resp.status !== 409) {
-                    const errMsg = await resp.text().catch(()=> '')
-                    console.error('POST fixed expense failed', monthKeyi, resp.status, errMsg)
+                return [...rest, optimistic]
+              })
+              setList(prev => prev.map(x => String(x.id)===id ? ({ ...x, last_paid_date: todayISO, status:'active' } as any) : x))
+              try {
+                const resType = (r.scope||'company')==='property' ? 'property_expenses' : 'company_expenses'
+                const createBody = { occurred_at: todayISO, amount: Number(r.amount||0), currency: 'AUD', category: r.category || 'other', note: 'Fixed payment', generated_from: 'recurring_payments', fixed_expense_id: fixedId, month_key: monthKey, due_date: dueISO, paid_date: todayISO, status: 'paid', property_id: r.property_id }
+                const createResp = await fetch(`${API_BASE}/crud/${resType}`, { method:'POST', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(createBody) })
+                if (createResp.ok) {
+                  const created = await createResp.json().catch(()=>null)
+                  if (created?.id) {
+                    setExpenses(prev => prev.map(e => (String(e.month_key||'')===monthKey && String(e.fixed_expense_id||'')===fixedId) ? ({ ...e, id: String(created.id) } as any) : e))
                   }
+                } else if (createResp.status === 409) {
+                  const qs = new URLSearchParams({ fixed_expense_id: fixedId, month_key: monthKey })
+                  const listRes = await fetch(`${API_BASE}/crud/${resType}?${qs.toString()}`, { headers: authHeaders() })
+                  const arr = listRes.ok ? await listRes.json().catch(()=>[]) : []
+                  const rows = Array.isArray(arr) ? arr : []
+                  await Promise.all(rows.filter((it:any)=>it?.id).map((it:any)=> fetch(`${API_BASE}/crud/${resType}/${it.id}`, { method:'PATCH', headers: { 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify({ paid_date: todayISO, status: 'paid', amount: Number(r.amount||0), due_date: dueISO }) })))
                 } else {
-                  for (const it of rows) {
-                    if (it?.id) {
-                      await fetch(`${API_BASE}/crud/${resType}/${it.id}`, { method:'PATCH', headers: { 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify({ paid_date: todayISO, status: 'paid', amount: Number(r.amount||0), due_date: dueISOi }) })
-                    }
-                  }
+                  const txt = await createResp.text().catch(()=> '')
+                  throw new Error(txt || `HTTP ${createResp.status}`)
                 }
+
+                const nextBase = m.add(freq,'month')
+                const nextDim = nextBase.endOf('month').date()
+                const nextISO = nextBase.startOf('month').date(Math.min(dueDay, nextDim)).format('YYYY-MM-DD')
+                const tplResp = await fetch(`${API_BASE}/crud/recurring_payments/${id}`, { method:'PATCH', headers: { 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify({ last_paid_date: todayISO, next_due_date: nextISO, status: 'active', frequency_months: freq }) })
+                if (!tplResp.ok) throw new Error(`HTTP ${tplResp.status}`)
+
+                message.open({ type:'success', content:'已标记为已付', key: msgKey })
+                void refreshMonth()
+              } catch (e:any) {
+                setExpenses(prev => {
+                  const rest = prev.filter(e2 => !(String(e2.month_key||'')===monthKey && String(e2.fixed_expense_id||'')===fixedId))
+                  return [...rest, ...prevExpenses]
+                })
+                if (prevTpl) setList(prev => prev.map(x => String(x.id)===id ? prevTpl : x))
+                message.open({ type:'error', content:(e?.message || '标记失败'), key: msgKey })
+              } finally {
+                setRowMutating(s => ({ ...s, [id]: undefined }))
               }
-              const nextBase = m.add(freq,'month')
-              const nextDim = nextBase.endOf('month').date()
-              const nextISO = nextBase.startOf('month').date(Math.min(dueDay, nextDim)).format('YYYY-MM-DD')
-              await fetch(`${API_BASE}/crud/recurring_payments/${r.id}`, { method:'PATCH', headers: { 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify({ last_paid_date: todayISO, next_due_date: nextISO, status: 'active', frequency_months: freq }) })
-              message.success('已标记为已付')
-              await load(); await refreshMonth()
-            } catch (e:any) {
-              message.error(e?.message || '生成支出失败')
-            }
-          }}>已付</Button>
+            }}
+          >
+            <Button type="primary" loading={rowMutating[String(r.id)]==='pay'} disabled={!!rowMutating[String(r.id)]}>已付</Button>
+          </Popconfirm>
         ))}
         <Popconfirm title="确认停用该固定支出？停用后不再生成新记录，历史支出保留不受影响。" okText="停用" cancelText="取消" onConfirm={async()=>{ try { const resp = await fetch(`${API_BASE}/crud/recurring_payments/${r.id}`, { method:'DELETE', headers: authHeaders() }); if (!resp.ok) throw new Error(`HTTP ${resp.status}`); message.success('已停用'); await load(); await refreshMonth() } catch (e:any) { message.error(e?.message || '停用失败') } }}>
           <Button danger>停用</Button>
@@ -296,16 +351,8 @@ export default function RecurringPage() {
         const autoPaid = shouldAutoMarkPaidForMonth(startKey || undefined, monthKey, currentMonthKey)
         const body = { occurred_at: dueISO, amount: Number(t.amount||0), currency: 'AUD', category: t.category || 'other', note: 'Fixed payment snapshot', generated_from: 'recurring_payments', fixed_expense_id: t.id, month_key: monthKey, due_date: dueISO, status: autoPaid ? 'paid' : 'unpaid', paid_date: autoPaid ? dueISO : null, property_id: t.property_id }
         try {
-          const qs = new URLSearchParams({ fixed_expense_id: String(t.id), month_key: monthKey })
-          const existingRes = await fetch(`${API_BASE}/crud/${resType}?${qs.toString()}`, { headers: authHeaders() })
-          let exists = false
-          if (existingRes.ok) {
-            const arr = await existingRes.json().catch(()=>[])
-            exists = Array.isArray(arr) && arr.length > 0
-          }
-          if (!exists) {
-            await fetch(`${API_BASE}/crud/${resType}`, { method:'POST', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(body) })
-          }
+          const resp = await fetch(`${API_BASE}/crud/${resType}`, { method:'POST', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(body) })
... (diff truncated) ...
```

### 修改 frontend/src/app/settings/invoice/page.tsx

- 变更类型: 修改
- 路径: frontend/src/app/settings/invoice/page.tsx
- 关联单号: 未提供

```diff
diff --git a/frontend/src/app/settings/invoice/page.tsx b/frontend/src/app/settings/invoice/page.tsx
index 6c4a883..32dd008 100644
--- a/frontend/src/app/settings/invoice/page.tsx
+++ b/frontend/src/app/settings/invoice/page.tsx
@@ -1,31 +1,102 @@
 "use client"
-import { Form, Input, InputNumber, Button, Card, App } from 'antd'
-import { useEffect } from 'react'
-import { getJSON, API_BASE, authHeaders } from '../../../lib/api'
+import { App, Button, Card, Col, Divider, Form, Input, InputNumber, Row, Tabs } from 'antd'
+import { useEffect, useMemo, useState } from 'react'
+import { API_BASE, authHeaders, getJSON } from '../../../lib/api'
+import { InvoiceCompaniesManager } from '../../../components/invoice/InvoiceCompaniesManager'
+import { InvoiceCustomersManager } from '../../../components/invoice/InvoiceCustomersManager'
 
 export default function InvoiceSettingsPage() {
-  const [form] = Form.useForm()
   const { message } = App.useApp()
-  useEffect(() => { getJSON<any>('/config/invoice').then((cfg)=>form.setFieldsValue(cfg)).catch(()=>{}) }, [])
-  async function save() {
-    const v = await form.validateFields()
-    const res = await fetch(`${API_BASE}/config/invoice`, { method:'PATCH', headers: { 'Content-Type':'application/json', ...authHeaders() }, body: JSON.stringify(v) })
+  const [baseForm] = Form.useForm()
+
+  async function loadBaseConfig() {
+    try {
+      const cfg = await getJSON<any>('/config/invoice')
+      baseForm.setFieldsValue(cfg || {})
+    } catch {}
+  }
+
+  async function saveBaseConfig() {
+    const v = await baseForm.validateFields()
+    const res = await fetch(`${API_BASE}/config/invoice`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(v) })
     if (!res.ok) { message.error('保存失败'); return }
-    const j = await res.json(); form.setFieldsValue(j); message.success('已保存')
+    const j = await res.json()
+    baseForm.setFieldsValue(j)
+    message.success('已保存')
   }
+
+  useEffect(() => {
+    loadBaseConfig().then(() => {})
+  }, [])
+
+  const tabs = useMemo(() => ([
+    {
+      key: 'companies',
+      label: '开票主体',
+      children: (
+        <Card bordered={false}>
+          <InvoiceCompaniesManager />
+        </Card>
+      ),
+    },
+    {
+      key: 'customers',
+      label: '常用客户',
+      children: (
+        <Card bordered={false}>
+          <InvoiceCustomersManager />
+        </Card>
+      ),
+    },
+    {
+      key: 'base',
+      label: '基础设置',
+      children: (
+        <Card bordered={false}>
+          <Form form={baseForm} layout="vertical">
+            <Row gutter={16}>
+              <Col xs={24} md={12}>
+                <Form.Item label="公司名称" name="company_name"><Input /></Form.Item>
+              </Col>
+              <Col xs={24} md={12}>
+                <Form.Item label="公司电话" name="company_phone"><Input /></Form.Item>
+              </Col>
+            </Row>
+            <Row gutter={16}>
+              <Col xs={24} md={12}>
+                <Form.Item label="ABN" name="company_abn"><Input /></Form.Item>
+              </Col>
+              <Col xs={24} md={12}>
+                <Form.Item label="Logo路径" name="logo_path"><Input /></Form.Item>
+              </Col>
+            </Row>
+            <Row gutter={16}>
+              <Col xs={24} md={12}>
+                <Form.Item label="税率(0-1)" name="tax_rate"><InputNumber step={0.01} min={0} max={1} style={{ width: 160 }} /></Form.Item>
+              </Col>
+            </Row>
+            <Divider />
+            <Row gutter={16}>
+              <Col xs={24} md={8}>
+                <Form.Item label="付款账户名" name="pay_account_name"><Input /></Form.Item>
+              </Col>
+              <Col xs={24} md={8}>
+                <Form.Item label="BSB" name="pay_bsb"><Input /></Form.Item>
+              </Col>
+              <Col xs={24} md={8}>
+                <Form.Item label="账号" name="pay_account_no"><Input /></Form.Item>
+              </Col>
+            </Row>
+            <Button type="primary" onClick={saveBaseConfig}>保存</Button>
+          </Form>
+        </Card>
+      ),
+    },
+  ]), [])
+
   return (
-    <Card title="发票设置">
-      <Form form={form} layout="vertical">
-        <Form.Item label="公司名称" name="company_name"><Input /></Form.Item>
-        <Form.Item label="公司电话" name="company_phone"><Input /></Form.Item>
-        <Form.Item label="ABN" name="company_abn"><Input /></Form.Item>
-        <Form.Item label="Logo路径" name="logo_path"><Input /></Form.Item>
-        <Form.Item label="税率(0-1)" name="tax_rate"><InputNumber step={0.01} min={0} max={1} style={{ width: 120 }} /></Form.Item>
-        <Form.Item label="付款账户名" name="pay_account_name"><Input /></Form.Item>
-        <Form.Item label="BSB" name="pay_bsb"><Input /></Form.Item>
-        <Form.Item label="账号" name="pay_account_no"><Input /></Form.Item>
-        <Button type="primary" onClick={save}>保存</Button>
-      </Form>
+    <Card title="发票设置" styles={{ body: { padding: 0 } }}>
+      <Tabs items={tabs as any} />
     </Card>
   )
-}
\ No newline at end of file
+}

```

### 新增 frontend/src/components/invoice/InvoiceCompaniesManager.tsx

- 变更类型: 新增
- 路径: frontend/src/components/invoice/InvoiceCompaniesManager.tsx
- 关联单号: 未提供

```diff
diff --git a/frontend/src/components/invoice/InvoiceCompaniesManager.tsx b/frontend/src/components/invoice/InvoiceCompaniesManager.tsx
new file mode 100644
index 0000000..ca022cd
--- /dev/null
+++ b/frontend/src/components/invoice/InvoiceCompaniesManager.tsx
@@ -0,0 +1,187 @@
+"use client"
+
+import { App, Button, Col, Divider, Form, Input, Modal, Popconfirm, Row, Select, Space, Switch, Table, Tag, Upload } from 'antd'
+import type { ColumnsType } from 'antd/es/table'
+import { useEffect, useMemo, useState } from 'react'
+import { API_BASE, authHeaders, getJSON } from '../../lib/api'
+
+export function InvoiceCompaniesManager(props: { bordered?: boolean; onChanged?: () => void }) {
+  const { message } = App.useApp()
+  const bordered = props.bordered ?? false
+  const [companies, setCompanies] = useState<any[]>([])
+  const [loading, setLoading] = useState(false)
+
+  const [modalOpen, setModalOpen] = useState(false)
+  const [editing, setEditing] = useState<any | null>(null)
+  const [form] = Form.useForm()
+  const [logoFile, setLogoFile] = useState<any | null>(null)
+
+  async function load() {
+    setLoading(true)
+    try {
+      const rows = await getJSON<any[]>('/invoices/companies')
+      setCompanies(Array.isArray(rows) ? rows : [])
+    } catch (e: any) {
+      message.error(String(e?.message || '加载失败'))
+    } finally {
+      setLoading(false)
+    }
+  }
+
+  useEffect(() => {
+    load().then(() => {})
+  }, [])
+
+  function openModal(company?: any) {
+    setEditing(company || null)
+    setLogoFile(null)
+    form.resetFields()
+    if (company) form.setFieldsValue({ ...company, is_default: !!company.is_default })
+    else form.setFieldsValue({ status: 'active', is_default: false })
+    setModalOpen(true)
+  }
+
+  async function submit() {
+    const v = await form.validateFields()
+    const payload: any = { ...v }
+    const isDefault = !!payload.is_default
+    delete payload.logo_url
+    const id = editing?.id
+    const method = id ? 'PATCH' : 'POST'
+    const url = id ? `${API_BASE}/invoices/companies/${id}` : `${API_BASE}/invoices/companies`
+    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ ...payload, is_default: isDefault }) })
+    const j = await res.json().catch(() => ({}))
+    if (!res.ok) { message.error(String(j?.message || '保存失败')); return }
+    const saved = j
+    if (logoFile?.file) {
+      const fd = new FormData()
+      fd.append('file', logoFile.file as any)
+      const up = await fetch(`${API_BASE}/invoices/companies/${saved.id}/logo/upload`, { method: 'POST', headers: { ...authHeaders() }, body: fd })
+      if (!up.ok) {
+        const uj = await up.json().catch(() => ({}))
+        message.error(String(uj?.message || 'Logo 上传失败'))
+      }
+    }
+    message.success('已保存')
+    setModalOpen(false)
+    await load()
+    props.onChanged?.()
+  }
+
+  async function deleteCompany(id: string) {
+    const res = await fetch(`${API_BASE}/invoices/companies/${id}`, { method: 'DELETE', headers: { ...authHeaders() } })
+    const j = await res.json().catch(() => ({}))
+    if (!res.ok) { message.error(String(j?.message || '删除失败')); return }
+    message.success('已删除')
+    await load()
+    props.onChanged?.()
+  }
+
+  const columns: ColumnsType<any> = useMemo(() => ([
+    { title: '代码', dataIndex: 'code', width: 110, render: (v) => v || '-' },
+    { title: '公司名称', dataIndex: 'legal_name', width: 240 },
+    { title: 'ABN/税号', dataIndex: 'abn', width: 160 },
+    { title: '邮箱', dataIndex: 'email', width: 220, render: (v) => v || '-' },
+    { title: '电话', dataIndex: 'phone', width: 140, render: (v) => v || '-' },
+    { title: '默认', dataIndex: 'is_default', width: 90, render: (v) => v ? <Tag color="blue">默认</Tag> : null },
+    { title: '状态', dataIndex: 'status', width: 120, render: (v) => String(v || 'active') === 'active' ? <Tag color="green">active</Tag> : <Tag>archived</Tag> },
+    { title: '操作', key: 'act', width: 220, fixed: 'right', render: (_: any, r: any) => (
+      <Space>
+        <Button size="small" onClick={() => openModal(r)}>编辑</Button>
+        <Popconfirm title="确认删除该开票主体？" okText="删除" cancelText="取消" onConfirm={() => deleteCompany(String(r.id))}>
+          <Button size="small" danger>删除</Button>
+        </Popconfirm>
+      </Space>
+    )},
+  ]), [companies])
+
+  return (
+    <>
+      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
+        <Button type="primary" onClick={() => openModal()}>新增开票主体</Button>
+      </div>
+      <Table rowKey="id" columns={columns} dataSource={companies} loading={loading} scroll={{ x: 1200 }} pagination={{ pageSize: 20 }} bordered={bordered} />
+
+      <Modal
+        title={editing ? '编辑开票主体' : '新增开票主体'}
+        open={modalOpen}
+        onCancel={() => setModalOpen(false)}
+        onOk={submit}
+        okText="保存"
+        cancelText="取消"
+        width={860}
+      >
+        <Form form={form} layout="vertical">
+          <Row gutter={16}>
+            <Col xs={24} md={8}>
+              <Form.Item label="代码" name="code"><Input placeholder="例如：INV" /></Form.Item>
+            </Col>
+            <Col xs={24} md={12}>
+              <Form.Item label="公司名称" name="legal_name" rules={[{ required: true, message: '必填' }]}><Input /></Form.Item>
+            </Col>
+            <Col xs={24} md={4}>
+              <Form.Item label="默认" name="is_default" valuePropName="checked"><Switch /></Form.Item>
+            </Col>
+          </Row>
+          <Row gutter={16}>
+            <Col xs={24} md={12}>
+              <Form.Item label="税号/ABN" name="abn" rules={[{ required: true, message: '必填' }]}><Input /></Form.Item>
+            </Col>
+            <Col xs={24} md={12}>
+              <Form.Item label="状态" name="status"><Select options={[{ value: 'active', label: 'active' }, { value: 'archived', label: 'archived' }]} /></Form.Item>
+            </Col>
+          </Row>
+          <Row gutter={16}>
+            <Col xs={24} md={12}>
+              <Form.Item label="邮箱" name="email"><Input /></Form.Item>
+            </Col>
+            <Col xs={24} md={12}>
+              <Form.Item label="电话" name="phone"><Input /></Form.Item>
+            </Col>
+          </Row>
+          <Row gutter={16}>
+            <Col xs={24} md={12}>
+              <Form.Item label="地址1" name="address_line1"><Input /></Form.Item>
+            </Col>
+            <Col xs={24} md={12}>
+              <Form.Item label="地址2" name="address_line2"><Input /></Form.Item>
+            </Col>
+          </Row>
+          <Row gutter={16}>
+            <Col xs={24} md={8}>
+              <Form.Item label="城市" name="address_city"><Input /></Form.Item>
+            </Col>
+            <Col xs={24} md={6}>
+              <Form.Item label="州" name="address_state"><Input /></Form.Item>
+            </Col>
+            <Col xs={24} md={5}>
+              <Form.Item label="邮编" name="address_postcode"><Input /></Form.Item>
+            </Col>
+            <Col xs={24} md={5}>
+              <Form.Item label="国家" name="address_country"><Input /></Form.Item>
+            </Col>
+          </Row>
+          <Divider />
+          <Row gutter={16}>
+            <Col xs={24} md={8}>
+              <Form.Item label="开户名" name="bank_account_name"><Input /></Form.Item>
+            </Col>
+            <Col xs={24} md={8}>
+              <Form.Item label="BSB" name="bank_bsb"><Input /></Form.Item>
+            </Col>
+            <Col xs={24} md={8}>
+              <Form.Item label="账号" name="bank_account_no"><Input /></Form.Item>
+            </Col>
+          </Row>
+          <Form.Item label="付款说明" name="payment_note"><Input.TextArea rows={2} /></Form.Item>
+          <Form.Item label="Logo（PNG/JPG）">
+            <Upload beforeUpload={() => false} maxCount={1} onChange={(info) => setLogoFile(info.fileList?.[0] || null)} fileList={logoFile ? [logoFile] : []}>
+              <Button>选择文件</Button>
+            </Upload>
+          </Form.Item>
+        </Form>
+      </Modal>
+    </>
+  )
+}
+

```

### 新增 frontend/src/components/invoice/InvoiceCustomersManager.tsx

- 变更类型: 新增
- 路径: frontend/src/components/invoice/InvoiceCustomersManager.tsx
- 关联单号: 未提供

```diff
diff --git a/frontend/src/components/invoice/InvoiceCustomersManager.tsx b/frontend/src/components/invoice/InvoiceCustomersManager.tsx
new file mode 100644
index 0000000..b3592a3
--- /dev/null
+++ b/frontend/src/components/invoice/InvoiceCustomersManager.tsx
@@ -0,0 +1,122 @@
+"use client"
+
+import { App, Button, Col, Form, Input, Modal, Popconfirm, Row, Select, Space, Table, Tag } from 'antd'
+import type { ColumnsType } from 'antd/es/table'
+import { useEffect, useMemo, useState } from 'react'
+import { API_BASE, authHeaders, getJSON } from '../../lib/api'
+
+export function InvoiceCustomersManager(props: { bordered?: boolean; onChanged?: () => void }) {
+  const { message } = App.useApp()
+  const bordered = props.bordered ?? false
+  const [customers, setCustomers] = useState<any[]>([])
+  const [loading, setLoading] = useState(false)
+
+  const [modalOpen, setModalOpen] = useState(false)
+  const [editing, setEditing] = useState<any | null>(null)
+  const [form] = Form.useForm()
+
+  async function load() {
+    setLoading(true)
+    try {
+      const rows = await getJSON<any[]>('/invoices/customers')
+      setCustomers(Array.isArray(rows) ? rows : [])
+    } catch (e: any) {
+      message.error(String(e?.message || '加载失败'))
+    } finally {
+      setLoading(false)
+    }
+  }
+
+  useEffect(() => {
+    load().then(() => {})
+  }, [])
+
+  function openModal(customer?: any) {
+    setEditing(customer || null)
+    form.resetFields()
+    if (customer) form.setFieldsValue({ ...customer, status: customer.status || 'active' })
+    else form.setFieldsValue({ status: 'active' })
+    setModalOpen(true)
+  }
+
+  async function submit() {
+    const v = await form.validateFields()
+    const id = editing?.id
+    const method = id ? 'PATCH' : 'POST'
+    const url = id ? `${API_BASE}/invoices/customers/${id}` : `${API_BASE}/invoices/customers`
+    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(v) })
+    const j = await res.json().catch(() => ({}))
+    if (!res.ok) { message.error(String(j?.message || '保存失败')); return }
+    message.success('已保存')
+    setModalOpen(false)
+    await load()
+    props.onChanged?.()
+  }
+
+  async function deleteCustomer(id: string) {
+    const res = await fetch(`${API_BASE}/invoices/customers/${id}`, { method: 'DELETE', headers: { ...authHeaders() } })
+    const j = await res.json().catch(() => ({}))
+    if (!res.ok) { message.error(String(j?.message || '删除失败')); return }
+    message.success('已删除')
+    await load()
+    props.onChanged?.()
+  }
+
+  const columns: ColumnsType<any> = useMemo(() => ([
+    { title: '客户名称', dataIndex: 'name', width: 220 },
+    { title: '税号', dataIndex: 'abn', width: 160, render: (v) => v || '-' },
+    { title: '邮箱', dataIndex: 'email', width: 220, render: (v) => v || '-' },
+    { title: '电话', dataIndex: 'phone', width: 140, render: (v) => v || '-' },
+    { title: '地址', dataIndex: 'address', width: 280, render: (v) => v || '-' },
+    { title: '状态', dataIndex: 'status', width: 120, render: (v) => String(v || 'active') === 'active' ? <Tag color="green">active</Tag> : <Tag>archived</Tag> },
+    { title: '操作', key: 'act', width: 220, fixed: 'right', render: (_: any, r: any) => (
+      <Space>
+        <Button size="small" onClick={() => openModal(r)}>编辑</Button>
+        <Popconfirm title="确认删除该客户？" okText="删除" cancelText="取消" onConfirm={() => deleteCustomer(String(r.id))}>
+          <Button size="small" danger>删除</Button>
+        </Popconfirm>
+      </Space>
+    )},
+  ]), [customers])
+
+  return (
+    <>
+      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
+        <Button type="primary" onClick={() => openModal()}>新增常用客户</Button>
+      </div>
+      <Table rowKey="id" columns={columns} dataSource={customers} loading={loading} scroll={{ x: 1200 }} pagination={{ pageSize: 20 }} bordered={bordered} />
+
+      <Modal
+        title={editing ? '编辑常用客户' : '新增常用客户'}
+        open={modalOpen}
+        onCancel={() => setModalOpen(false)}
+        onOk={submit}
+        okText="保存"
+        cancelText="取消"
+        width={760}
+      >
+        <Form form={form} layout="vertical">
+          <Row gutter={16}>
+            <Col xs={24} md={12}>
+              <Form.Item label="客户名称" name="name" rules={[{ required: true, message: '必填' }]}><Input /></Form.Item>
+            </Col>
+            <Col xs={24} md={12}>
+              <Form.Item label="税号" name="abn"><Input /></Form.Item>
+            </Col>
+          </Row>
+          <Row gutter={16}>
+            <Col xs={24} md={12}>
+              <Form.Item label="电子邮箱" name="email"><Input /></Form.Item>
+            </Col>
+            <Col xs={24} md={12}>
+              <Form.Item label="联系电话" name="phone"><Input /></Form.Item>
+            </Col>
+          </Row>
+          <Form.Item label="联系地址" name="address"><Input.TextArea rows={2} /></Form.Item>
+          <Form.Item label="状态" name="status"><Select options={[{ value: 'active', label: 'active' }, { value: 'archived', label: 'archived' }]} /></Form.Item>
+        </Form>
+      </Modal>
+    </>
+  )
+}
+

```

### 修改 frontend/src/lib/invoiceEditorModel.ts

- 变更类型: 修改
- 路径: frontend/src/lib/invoiceEditorModel.ts
- 关联单号: 未提供

```diff
diff --git a/frontend/src/lib/invoiceEditorModel.ts b/frontend/src/lib/invoiceEditorModel.ts
index 13258fc..f41819e 100644
--- a/frontend/src/lib/invoiceEditorModel.ts
+++ b/frontend/src/lib/invoiceEditorModel.ts
@@ -1,4 +1,4 @@
-export type GstType = 'GST_10' | 'GST_FREE' | 'INPUT_TAXED'
+export type GstType = 'GST_10' | 'GST_INCLUDED_10' | 'GST_FREE' | 'INPUT_TAXED'
 
 export type InvoiceLineItemInput = {
   description: string
@@ -23,11 +23,16 @@ function round2(n: any) {
 export function computeLine(item: { quantity: number; unit_price: number; gst_type: GstType }) {
   const qty = Number(item.quantity || 0)
   const unit = Number(item.unit_price || 0)
-  const lineSubtotal = round2(qty * unit)
+  const base = round2(qty * unit)
+  if (item.gst_type === 'GST_INCLUDED_10') {
+    const tax = round2(base / 11)
+    const sub = round2(base - tax)
+    return { line_subtotal: sub, tax_amount: tax, line_total: base }
+  }
   let tax = 0
-  if (item.gst_type === 'GST_10') tax = round2(lineSubtotal * 0.1)
-  const lineTotal = round2(lineSubtotal + tax)
-  return { line_subtotal: lineSubtotal, tax_amount: tax, line_total: lineTotal }
+  if (item.gst_type === 'GST_10') tax = round2(base * 0.1)
+  const lineTotal = round2(base + tax)
+  return { line_subtotal: base, tax_amount: tax, line_total: lineTotal }
 }
 
 export function computeTotals(lines: Array<{ line_subtotal: number; tax_amount: number; line_total: number }>, amountPaid: any): InvoiceTotals {
@@ -83,4 +88,3 @@ export function stableHash(obj: any) {
   }
   return String(h)
 }
-

```

### 新增 frontend/src/lib/invoicePayload.test.ts

- 变更类型: 新增
- 路径: frontend/src/lib/invoicePayload.test.ts
- 关联单号: 未提供

```diff
diff --git a/frontend/src/lib/invoicePayload.test.ts b/frontend/src/lib/invoicePayload.test.ts
new file mode 100644
index 0000000..7eba82b
--- /dev/null
+++ b/frontend/src/lib/invoicePayload.test.ts
@@ -0,0 +1,64 @@
+import { describe, expect, it } from 'vitest'
+import dayjs from 'dayjs'
+import { buildInvoicePayload } from './invoicePayload'
+
+describe('buildInvoicePayload', () => {
+  it('builds invoice draft payload with due_date and gst types preserved', () => {
+    const values = {
+      company_id: 'c1',
+      invoice_type: 'invoice',
+      currency: 'AUD',
+      issue_date: dayjs('2026-02-07'),
+      due_date: dayjs('2026-02-21'),
+      line_items: [
+        { description: 'A', quantity: 1, unit_price: 100, gst_type: 'GST_10' },
+      ],
+    }
+    const p: any = buildInvoicePayload(values, 'draft', 0)
+    expect(p.invoice_type).toBe('invoice')
+    expect(p.due_date).toBe('2026-02-21')
+    expect(p.valid_until).toBeUndefined()
+    expect(p.line_items[0].gst_type).toBe('GST_10')
+  })
+
+  it('builds quote draft payload with valid_until and gst hidden (GST_FREE)', () => {
+    const values = {
+      company_id: 'c1',
+      invoice_type: 'quote',
+      currency: 'AUD',
+      issue_date: dayjs('2026-02-07'),
+      valid_until: dayjs('2026-03-09'),
+      due_date: dayjs('2026-02-21'),
+      line_items: [
+        { description: 'A', quantity: 2, unit_price: 50, gst_type: 'GST_10' },
+      ],
+    }
+    const p: any = buildInvoicePayload(values, 'draft', 0)
+    expect(p.invoice_type).toBe('quote')
+    expect(p.valid_until).toBe('2026-03-09')
+    expect(p.due_date).toBeUndefined()
+    expect(p.line_items[0].gst_type).toBe('GST_FREE')
+  })
+
+  it('builds receipt draft payload with line items and gst hidden (GST_FREE)', () => {
+    const values = {
+      company_id: 'c1',
+      invoice_type: 'receipt',
+      currency: 'AUD',
+      issue_date: dayjs('2026-02-07'),
+      payment_method: 'cash',
+      line_items: [
+        { description: 'A', quantity: 1, unit_price: 100, gst_type: 'GST_10' },
+        { description: 'B', quantity: 2, unit_price: 50, gst_type: 'GST_INCLUDED_10' },
+      ],
+    }
+    const p: any = buildInvoicePayload(values, 'draft', 0)
+    expect(p.invoice_type).toBe('receipt')
+    expect(p.amount_paid).toBeUndefined()
+    expect(p.paid_at).toBeUndefined()
+    expect(p.due_date).toBeUndefined()
+    expect(p.line_items).toHaveLength(2)
+    expect(p.line_items[0].gst_type).toBe('GST_FREE')
+    expect(p.line_items[1].gst_type).toBe('GST_FREE')
+  })
+})

```

### 新增 frontend/src/lib/invoicePayload.ts

- 变更类型: 新增
- 路径: frontend/src/lib/invoicePayload.ts
- 关联单号: 未提供

```diff
diff --git a/frontend/src/lib/invoicePayload.ts b/frontend/src/lib/invoicePayload.ts
new file mode 100644
index 0000000..bf48ab8
--- /dev/null
+++ b/frontend/src/lib/invoicePayload.ts
@@ -0,0 +1,48 @@
+"use client"
+
+import dayjs from 'dayjs'
+import type { GstType, InvoiceLineItemInput } from './invoiceEditorModel'
+import { normalizeLineItemsForSave } from './invoiceEditorModel'
+
+export function buildInvoicePayload(values: any, status: string, discountAmount: number) {
+  if (status !== 'draft') {
+    return {
+      bill_to_email: values.bill_to_email || undefined,
+      bill_to_phone: values.bill_to_phone || undefined,
+      bill_to_abn: values.bill_to_abn || undefined,
+      bill_to_address: values.bill_to_address || undefined,
+      notes: values.notes || undefined,
+      terms: values.terms || undefined,
+      due_date: values.due_date ? dayjs(values.due_date).format('YYYY-MM-DD') : undefined,
+      payment_method: values.payment_method || undefined,
+      payment_method_note: values.payment_method_note || undefined,
+    }
+  }
+
+  const t = String(values.invoice_type || 'invoice')
+  const isQuote = t === 'quote'
+  const isReceipt = t === 'receipt'
+  const userItems = (values.line_items || []) as InvoiceLineItemInput[]
+  const items0 = normalizeLineItemsForSave({ user_items: userItems, discount_amount: discountAmount })
+  const items = (isQuote || isReceipt) ? items0.map((x) => ({ ...x, gst_type: 'GST_FREE' as GstType })) : items0
+
+  return {
+    company_id: values.company_id,
+    invoice_type: t,
+    currency: values.currency || 'AUD',
+    customer_id: values.customer_id || undefined,
+    bill_to_name: values.bill_to_name || undefined,
+    bill_to_email: values.bill_to_email || undefined,
+    bill_to_phone: values.bill_to_phone || undefined,
+    bill_to_abn: values.bill_to_abn || undefined,
+    bill_to_address: values.bill_to_address || undefined,
+    payment_method: values.payment_method || undefined,
+    payment_method_note: values.payment_method_note || undefined,
+    notes: values.notes || undefined,
+    terms: values.terms || undefined,
+    issue_date: values.issue_date ? dayjs(values.issue_date).format('YYYY-MM-DD') : undefined,
+    due_date: (!isQuote && !isReceipt && values.due_date) ? dayjs(values.due_date).format('YYYY-MM-DD') : undefined,
+    valid_until: (isQuote && values.valid_until) ? dayjs(values.valid_until).format('YYYY-MM-DD') : undefined,
+    line_items: items.map((x) => ({ description: x.description, quantity: Number(x.quantity), unit_price: Number(x.unit_price), gst_type: x.gst_type })),
+  }
+}

```

### 修改 frontend/src/lib/invoiceTemplateHtml.ts

- 变更类型: 修改
- 路径: frontend/src/lib/invoiceTemplateHtml.ts
- 关联单号: 未提供

```diff
diff --git a/frontend/src/lib/invoiceTemplateHtml.ts b/frontend/src/lib/invoiceTemplateHtml.ts
index 9b24456..9eca573 100644
--- a/frontend/src/lib/invoiceTemplateHtml.ts
+++ b/frontend/src/lib/invoiceTemplateHtml.ts
@@ -8,7 +8,7 @@ export type InvoiceTemplateData = {
 }
 
 export function normalizeAssetUrl(url: string): string {
-  const u = String(url || '')
+  const u = String(url || '').trim()
   if (!u) return ''
   if (/^https?:\/\//i.test(u)) return u
   if (u.startsWith('/')) return `${API_BASE}${u}`

```

### 新增 frontend/src/lib/invoiceTemplateRuntime.test.ts

- 变更类型: 新增
- 路径: frontend/src/lib/invoiceTemplateRuntime.test.ts
- 关联单号: 未提供

```diff
diff --git a/frontend/src/lib/invoiceTemplateRuntime.test.ts b/frontend/src/lib/invoiceTemplateRuntime.test.ts
new file mode 100644
index 0000000..af7286a
--- /dev/null
+++ b/frontend/src/lib/invoiceTemplateRuntime.test.ts
@@ -0,0 +1,14 @@
+import { describe, expect, it } from 'vitest'
+import fs from 'node:fs'
+import path from 'node:path'
+
+describe('invoice-template runtime', () => {
+  it('renders different content by invoice_type (quote/invoice/receipt)', () => {
+    const p = path.join(process.cwd(), 'public', 'invoice-templates', 'invoice-template.js')
+    const s = fs.readFileSync(p, 'utf8')
+    expect(s).toContain('inv.invoice_type')
+    expect(s).toContain('QUOTE')
+    expect(s).toContain('RECEIPT')
+    expect(s).toContain('本报价单仅供参考，具体以实际交易为准')
+  })
+})

```

### 修改 frontend/src/lib/taxInvoicePdf.ts

- 变更类型: 修改
- 路径: frontend/src/lib/taxInvoicePdf.ts
- 关联单号: 未提供

```diff
diff --git a/frontend/src/lib/taxInvoicePdf.ts b/frontend/src/lib/taxInvoicePdf.ts
index 1cb0ab2..b658e72 100644
--- a/frontend/src/lib/taxInvoicePdf.ts
+++ b/frontend/src/lib/taxInvoicePdf.ts
@@ -1,6 +1,6 @@
 import { jsPDF } from 'jspdf'
 
-export type GstType = 'GST_10' | 'GST_FREE' | 'INPUT_TAXED'
+export type GstType = 'GST_10' | 'GST_INCLUDED_10' | 'GST_FREE' | 'INPUT_TAXED'
 
 export type InvoicePdfCompany = {
   legal_name: string
@@ -60,14 +60,28 @@ function fmtMoney(n: any) {
   return `$${round2(n).toFixed(2)}`
 }
 
+function splitItemDesc(raw: any) {
+  const s0 = String(raw || '').replace(/\r\n/g, '\n').trim()
+  if (!s0) return { title: '-', content: '' }
+  const parts = s0.split('\n')
+  const title = String(parts.shift() || '').trim() || '-'
+  const content = parts.join('\n').trim()
+  return { title, content }
+}
+
 function computeLine(item: { quantity: number; unit_price: number; gst_type: GstType }) {
   const qty = Number(item.quantity || 0)
   const unit = Number(item.unit_price || 0)
-  const lineSubtotal = round2(qty * unit)
+  const base = round2(qty * unit)
+  if (item.gst_type === 'GST_INCLUDED_10') {
+    const tax = round2(base / 11)
+    const sub = round2(base - tax)
+    return { line_subtotal: sub, tax_amount: tax, line_total: base }
+  }
   let tax = 0
-  if (item.gst_type === 'GST_10') tax = round2(lineSubtotal * 0.1)
-  const lineTotal = round2(lineSubtotal + tax)
-  return { line_subtotal: lineSubtotal, tax_amount: tax, line_total: lineTotal }
+  if (item.gst_type === 'GST_10') tax = round2(base * 0.1)
+  const lineTotal = round2(base + tax)
+  return { line_subtotal: base, tax_amount: tax, line_total: lineTotal }
 }
 
 function computeTotals(lines: Array<{ line_subtotal: number; tax_amount: number; line_total: number }>, amountPaid: any) {
@@ -206,17 +220,24 @@ export async function buildTaxInvoicePdf(params: { invoice: InvoicePdfData; comp
 
   const maxDescWidth = 300
   for (const li of computedLines) {
-    const desc = String(li.description || '').trim() || '-'
-    const lines = doc.splitTextToSize(desc, maxDescWidth) as string[]
-    const rowHeight = Math.max(1, lines.length) * 14
+    const d = splitItemDesc(li.description)
+    doc.setFont('helvetica', 'bold')
+    const titleLines = doc.splitTextToSize(String(d.title || '-'), maxDescWidth) as string[]
+    doc.setFont('helvetica', 'normal')
+    const contentLines = d.content ? (doc.splitTextToSize(String(d.content), maxDescWidth) as string[]) : []
+    const rowHeight = Math.max(1, titleLines.length + contentLines.length) * 14
     if (tableY + rowHeight > 700) {
       doc.addPage()
       tableY = 80
     }
-    doc.text(lines, leftX, tableY)
+    doc.setFont('helvetica', 'bold')
+    doc.text(titleLines, leftX, tableY)
+    const y2 = tableY + titleLines.length * 14
+    doc.setFont('helvetica', 'normal')
+    if (contentLines.length) doc.text(contentLines, leftX, y2)
     doc.text(String(li.quantity ?? ''), 360, tableY)
     doc.text(fmtMoney(li.unit_price), 420, tableY)
-    doc.text(li.gst_type === 'GST_10' ? '10%' : (li.gst_type === 'GST_FREE' ? 'Free' : 'Input'), 480, tableY)
+    doc.text(li.gst_type === 'GST_10' ? 'Excl' : (li.gst_type === 'GST_INCLUDED_10' ? 'Incl' : 'No'), 480, tableY)
     doc.text(fmtMoney(li.line_total), rightX, tableY, { align: 'right' })
     tableY += rowHeight
     doc.setDrawColor(245)

```

### 修改 vercel.json

- 变更类型: 修改
- 路径: vercel.json
- 关联单号: 未提供

```diff
diff --git a/vercel.json b/vercel.json
index c6c779f..cea85b1 100644
--- a/vercel.json
+++ b/vercel.json
@@ -1 +1,2 @@
-{"rewrites":[{"source":"/(.*)","destination":"/index.html"}]}
\ No newline at end of file
+{"rewrites":[{"source":"/(.*)","destination":"/index.html"}]}
+

```

