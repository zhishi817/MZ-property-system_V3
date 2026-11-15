import { Router } from 'express'
import { pgPool, pgRunInTransaction } from '../dbAdapter'
import { userHasAnyPerm } from '../auth'
import { deepCleaningMediaContexts, deepCleaningAvailableActions, deepCleaningStatus, deepCleaningIsAdmin, deepCleaningReviewPrice, deepCleaningWorkflowResponse } from '../lib/deepCleaningWorkflow'
import { assertMaintenanceRuntimeSchemaReady } from '../lib/maintenanceRuntimeSchema'
import { assertIdempotentStepReceiptsReady, buildCanonicalIdempotencyPayloadHash, loadIdempotentStepReceipt, saveIdempotentStepReceipt } from '../lib/idempotentStepReceipts'
import { isDeepCleaningExecutorEligibleRoleNames } from '../lib/deepCleaningWorkflow'
import { buildWorkTaskVisibilityHints, emitWorkTaskEvent } from '../services/workTaskEvents'
import { syncDeepCleaningReviewedExpenseWithClient } from './crud'

export const deepCleaningWorkflowRouter = Router()
const manage = (user: any) => userHasAnyPerm(user, ['property_deep_cleaning.write'])
const isReportManager = (user: any) => [user?.role,...(Array.isArray(user?.roles) ? user.roles : [])].some(role => role === 'admin' || role === 'offline_manager')
const actorId = (user: any) => String(user?.sub || user?.id || '')
class WorkflowError extends Error { constructor(public status: number, message: string) { super(message) } }
async function rolesFor(client: any, id: string) {
  const users = await client.query('SELECT id, role, username, display_name FROM users WHERE id::text=$1 FOR SHARE', [id])
  const row = users.rows?.[0]
  if (!row) return null
  const roles = await client.query('SELECT role_name FROM user_roles WHERE user_id::text=$1 FOR SHARE', [id])
  return {...row, roles: [row.role,...(roles.rows || []).map((x:any) => x.role_name)]}
}
function fail(res: any, error: any) {
  if (['42P01','42703'].includes(String(error?.code))) return res.status(503).json({code:'deep_cleaning_schema_not_ready'})
  if (error instanceof WorkflowError) return res.status(error.status).json({code:error.message})
  if (/not_ready/.test(String(error?.message))) return res.status(503).json({code:error.message})
  if (/^deep_cleaning_/.test(String(error?.message))) return res.status(400).json({code:error.message})
  return res.status(500).json({code:'deep_cleaning_workflow_failed'})
}
deepCleaningWorkflowRouter.get('/executors', async (req,res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({code:'unauthorized'})
  if (!isReportManager(user) && !await manage(user)) return res.status(403).json({code:'forbidden'})
  if (!pgPool) return res.status(503).json({code:'pg_required'})
  try {
    const result = await pgPool.query(`SELECT u.id::text, u.role, u.username, u.display_name,
      COALESCE(array_agg(ur.role_name) FILTER (WHERE ur.role_name IS NOT NULL), '{}') AS roles
      FROM users u LEFT JOIN user_roles ur ON ur.user_id::text=u.id::text GROUP BY u.id ORDER BY u.username,u.id`)
    return res.json(result.rows.filter((u:any) => isDeepCleaningExecutorEligibleRoleNames([u.role,...u.roles]))
      .map((u:any) => ({id:u.id,name:u.display_name || u.username || u.id})))
  } catch (e) { return fail(res,e) }
})
// Read-only recovery of an existing legacy queue checkpoint; never infer its owner.
deepCleaningWorkflowRouter.get('/records/:id/recovery-context', async (req,res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({code:'unauthorized'})
  if (!pgPool) return res.status(503).json({code:'pg_required'})
  try {
    const actor = await rolesFor(pgPool,actorId(user))
    if (!actor || !isReportManager(actor)) throw new WorkflowError(403,'forbidden')
    const row = (await pgPool.query('SELECT id,property_id,created_by_user_id,source_task_id,status,review_status,repair_photo_urls FROM property_deep_cleaning WHERE id=$1 AND deleted_at IS NULL',[req.params.id])).rows[0]
    if (!row || String(row.created_by_user_id || '') !== actorId(user)) throw new WorkflowError(404,'deep_cleaning_not_found')
    const source = String(req.query.source_task_id || '')
    if (!source || source !== String(row.source_task_id || '')) throw new WorkflowError(403,'property_feedback_source_task_forbidden')
    const access = await require('./mzapp').propertyFeedbackSourceTaskAccess({...actor,sub:actorId(user)},String(row.property_id),source)
    if (!access.exists || !access.canCreate) throw new WorkflowError(403,'property_feedback_source_task_forbidden')
    const status = deepCleaningStatus(row)
    return res.json({record_id:row.id,source_task_id:source,owner_user_id:row.created_by_user_id,workflow_status:status,can_resume:['pending','pending_assignment','assigned','in_progress','open','todo'].includes(status),completion_photo_urls:Array.isArray(row.repair_photo_urls) ? row.repair_photo_urls : []})
  } catch (e) { return fail(res,e) }
})
deepCleaningWorkflowRouter.post('/records/:id/workflow/:action', async (req,res) => {
  const user = (req as any).user
  if (!user) return res.status(401).json({code:'unauthorized'})
  const id = String(req.params.id || '')
  const action = String(req.params.action || '')
  const body = req.body || {}
  if (!['assign','complete','review','record_complete'].includes(action)) return res.status(400).json({code:'deep_cleaning_action_invalid'})
  if (typeof body.operation_id !== 'string' || !/^[a-zA-Z0-9_-]{8,120}$/.test(body.operation_id)) return res.status(400).json({code:'deep_cleaning_operation_id_required'})
  const allowed = new Set(['operation_id', ...(action === 'assign' ? ['assignee_id','scheduled_date'] : action === 'record_complete' ? ['assignee_id','initial_report','completion_photo_urls','completion_note','started_at','ended_at'] : action === 'complete' ? ['before_photo_urls','completion_photo_urls','completion_note','started_at','ended_at'] : ['assignee_id','pricing_mode','total_amount','price_items','pay_method','gst_type','review_notes'])])
  if (Object.keys(body).some(key => !allowed.has(key))) return res.status(400).json({code:'deep_cleaning_unexpected_field'})
  if (!pgPool) return res.status(503).json({code:'pg_required'})
  try {
    assertMaintenanceRuntimeSchemaReady()
    const canAssign = await manage(user)
    let committedNotice: any = null
    const response = await pgRunInTransaction(async client => {
      await assertIdempotentStepReceiptsReady(client)
      // Serialize a client-created report identity before insert/replay (including concurrent requests).
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`deep_cleaning_workflow:${id}`])
      const actor = await rolesFor(client,actorId(user))
      if (!actor) throw new WorkflowError(403,'forbidden')
      const authenticatedActor = {...user,role:actor.role,roles:actor.roles}
      const result = await client.query('SELECT * FROM property_deep_cleaning WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id])
      let row = result.rows[0]
      let createdReport = false
      if (action === 'record_complete' && !row) {
        if (!isReportManager(authenticatedActor)) throw new WorkflowError(403,'deep_cleaning_action_forbidden')
        if (!/^[a-f0-9-]{36}$/i.test(id)) throw new WorkflowError(400,'deep_cleaning_record_id_invalid')
        const report = body.initial_report
        if (!report || typeof report.property_id !== 'string' || !Array.isArray(report.areas) || !report.areas.length || report.areas.some((x:any) => typeof x !== 'string' || !x.trim()) || typeof report.detail !== 'string' || !report.detail.trim() || !Array.isArray(report.photo_urls) || !report.photo_urls.length || report.photo_urls.some((x:any) => typeof x !== 'string' || !x.trim() || /^(file:|blob:|data:)/i.test(x))) throw new WorkflowError(400,'deep_cleaning_report_invalid')
        if (Object.keys(report).some(k => !['property_id','areas','detail','photo_urls','source_task_id','client_item_id'].includes(k))) throw new WorkflowError(400,'deep_cleaning_report_invalid')
        if (report.client_item_id != null && (typeof report.client_item_id !== 'string' || !report.client_item_id.trim())) throw new WorkflowError(400,'deep_cleaning_report_invalid')
        const clientItemId = report.client_item_id || id
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`deep_cleaning_client:${report.property_id}:${clientItemId}`])
        const duplicate = await client.query('SELECT id FROM property_deep_cleaning WHERE property_id=$1 AND client_item_id=$2 LIMIT 1',[report.property_id,clientItemId])
        if (duplicate.rows.length) throw new WorkflowError(409,'deep_cleaning_client_item_exists')
        const sourceTaskId = typeof report.source_task_id === 'string' ? report.source_task_id.trim() : ''
        if (sourceTaskId) {
          const access = await require('./mzapp').propertyFeedbackSourceTaskAccess(authenticatedActor, report.property_id, sourceTaskId)
          if (!access.exists || !access.canCreate) throw new WorkflowError(403,'property_feedback_source_task_forbidden')
        }
        const property = await client.query('SELECT id,code FROM properties WHERE id=$1 FOR SHARE',[report.property_id])
        if (!property.rows.length) throw new WorkflowError(400,'deep_cleaning_property_not_found')
        const assignee = await rolesFor(client,String(body.assignee_id || ''))
        if (!assignee || !isDeepCleaningExecutorEligibleRoleNames(assignee.roles)) throw new WorkflowError(400,'task_assignee_invalid')
        const columns = (await client.query(`SELECT column_name,data_type,udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='property_deep_cleaning' AND column_name IN ('photo_urls','attachment_urls')`)).rows
        const mediaCast = (name:string) => { const col = columns.find((x:any) => x.column_name === name); const cast = col?.udt_name === '_text' ? 'text[]' : col?.data_type === 'jsonb' ? 'jsonb' : null; if (!cast) throw new WorkflowError(503,'deep_cleaning_media_schema_not_ready'); return cast }
        const beforeCast = mediaCast('photo_urls'); const attachmentCast = mediaCast('attachment_urls')
        row = (await client.query(`INSERT INTO property_deep_cleaning(id,property_id,property_code,occurred_at,status,assignee_id,worker_name,photo_urls,attachment_urls,project_desc,details,created_by,created_by_user_id,submitter_name,submitted_at,created_at,updated_at,review_status,work_no,source_task_id,client_item_id)
          VALUES($1,$2,$3,(now() AT TIME ZONE 'Australia/Melbourne')::date,'assigned',$4,$5,$6::${beforeCast},${attachmentCast === 'jsonb' ? "'[]'::jsonb" : "ARRAY[]::text[]"},$7,$8,$9,$9,$10,now(),now(),now(),'pending',$11,$12,$13) RETURNING *`,
          [id,report.property_id,property.rows[0].code || null,body.assignee_id,assignee.display_name || assignee.username || assignee.id,beforeCast === 'jsonb' ? JSON.stringify(report.photo_urls) : report.photo_urls,report.areas.join('、'),report.detail.trim(),actorId(user),actor.display_name || actor.username || actorId(user),`DC-${id}`,sourceTaskId || null,report.client_item_id || id])).rows[0]
        createdReport = true
      }
      if (!row) throw new WorkflowError(404,'deep_cleaning_not_found')
      // Re-read authoritative roles in the transaction; manage permission alone never grants review.
      const authorizedActor = action === 'record_complete' ? isReportManager(authenticatedActor) : action === 'assign' ? canAssign : action === 'review' ? deepCleaningIsAdmin(authenticatedActor) : String(row.assignee_id || '') === actorId(user)
      if (!authorizedActor) throw new WorkflowError(403,'deep_cleaning_action_forbidden')
      const scope = {scopeType:'deep_cleaning_workflow',scopeId:`${id}:${actorId(user)}`,submitId:body.operation_id,stepKey:action}
      const hash = buildCanonicalIdempotencyPayloadHash(body)
      const receipt = await loadIdempotentStepReceipt(client,scope)
      if (receipt) {
        if (receipt.payload_hash !== hash) throw new WorkflowError(409,'deep_cleaning_operation_conflict')
        const saved = typeof receipt.response_json === 'string' ? JSON.parse(receipt.response_json) : receipt.response_json
        return deepCleaningWorkflowResponse({...saved,media_access_work_task_id:(await deepCleaningMediaContexts(client,[row])).get(id) || null},authenticatedActor,canAssign)
      }
      if (action === 'record_complete' ? !['pending','pending_assignment','assigned','in_progress','open','todo'].includes(String(row.status)) : !deepCleaningAvailableActions(row,authenticatedActor,canAssign).includes(action)) throw new WorkflowError(409,'deep_cleaning_transition_invalid')
      let updated:any
      let price:any = null
      if (action === 'assign') {
        if (typeof body.assignee_id !== 'string' || !body.assignee_id.trim()) throw new WorkflowError(400,'deep_cleaning_assignee_required')
        const assignee = await rolesFor(client,body.assignee_id.trim())
        if (!assignee || !isDeepCleaningExecutorEligibleRoleNames(assignee.roles)) throw new WorkflowError(400,'task_assignee_invalid')
        const date = body.scheduled_date === undefined ? row.eta : body.scheduled_date
        if (date != null && date !== '' && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))) throw new WorkflowError(400,'deep_cleaning_date_invalid')
        updated = (await client.query(`UPDATE property_deep_cleaning SET assignee_id=$2,worker_name=$3,eta=$4::date,status='assigned',updated_at=now() WHERE id=$1 RETURNING *`,[id,body.assignee_id.trim(),assignee.display_name || assignee.username || assignee.id,date || null])).rows[0]
      } else if (action === 'complete' || action === 'record_complete') {
        if (action === 'record_complete') {
          const assignee = await rolesFor(client,String(body.assignee_id || ''))
          if (!assignee || !isDeepCleaningExecutorEligibleRoleNames(assignee.roles)) throw new WorkflowError(400,'task_assignee_invalid')
          row = (await client.query('UPDATE property_deep_cleaning SET assignee_id=$2,worker_name=$3 WHERE id=$1 RETURNING *',[id,body.assignee_id,assignee.display_name || assignee.username || assignee.id])).rows[0]
        }
        // Optional task-executor before evidence is committed with completion, never
        // replacing the original report or mixing its phase with after evidence.
        if (body.before_photo_urls !== undefined) {
          if (!Array.isArray(body.before_photo_urls) || body.before_photo_urls.some((x:any) => typeof x !== 'string' || !x.trim() || /^(blob:|file:|data:)/i.test(x.trim()))) throw new WorkflowError(400,'deep_cleaning_before_photo_invalid')
          const beforeType=(await client.query(`SELECT data_type,udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='property_deep_cleaning' AND column_name='photo_urls'`)).rows[0]
          const beforeCast=beforeType?.udt_name==='_text' ? 'text[]' : beforeType?.data_type==='jsonb' ? 'jsonb' : null
          if (!beforeCast) throw new WorkflowError(503,'deep_cleaning_media_schema_not_ready')
          let existingBefore=row.photo_urls
          if (existingBefore == null || (typeof existingBefore === 'string' && !existingBefore.trim())) existingBefore=[]
          else if (typeof existingBefore==='string') {
            try { existingBefore=JSON.parse(existingBefore) } catch { throw new WorkflowError(409,'deep_cleaning_before_photo_source_invalid') }
          }
          if (!Array.isArray(existingBefore) || existingBefore.some((x:any)=>typeof x!=='string' || !x.trim() || /^(blob:|file:|data:)/i.test(x.trim()))) throw new WorkflowError(409,'deep_cleaning_before_photo_source_invalid')
          // Preserve every valid stored reference byte-for-byte; never repair old
          // malformed evidence by dropping it during an unrelated completion.
          const beforePhotos=Array.from(new Set([...existingBefore,...body.before_photo_urls.map((x:string)=>x.trim())]))
          row=(await client.query(`UPDATE property_deep_cleaning SET photo_urls=$2::${beforeCast} WHERE id=$1 RETURNING *`,[id,beforeCast==='jsonb' ? JSON.stringify(beforePhotos) : beforePhotos])).rows[0]
        }
        if (!Array.isArray(body.completion_photo_urls) || !body.completion_photo_urls.length || body.completion_photo_urls.some((x:any) => typeof x !== 'string' || !x.trim() || /^(blob:|file:|data:)/i.test(x))) throw new WorkflowError(400,'deep_cleaning_completion_photo_required')
        if (body.completion_note != null && (typeof body.completion_note !== 'string')) throw new WorkflowError(400,'deep_cleaning_note_invalid')
        const start = body.started_at === undefined ? (row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at) : body.started_at
        const end = body.ended_at === undefined ? (row.ended_at instanceof Date ? row.ended_at.toISOString() : row.ended_at) : body.ended_at
        for (const value of [start,end]) if (value != null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) throw new WorkflowError(400,'deep_cleaning_time_invalid')
        if (start && end && Date.parse(end) < Date.parse(start)) throw new WorkflowError(400,'deep_cleaning_time_invalid')
        const duration = start && end ? Math.trunc((Date.parse(end)-Date.parse(start))/60000) : row.duration_minutes ?? null
        const mediaType = await client.query(`SELECT data_type,udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='property_deep_cleaning' AND column_name='repair_photo_urls'`)
        const col = mediaType.rows[0]
        const cast = col?.udt_name === '_text' ? 'text[]' : col?.data_type === 'jsonb' ? 'jsonb' : null
        if (!cast) throw new WorkflowError(503,'deep_cleaning_media_schema_not_ready')
        let existingPhotos = row.repair_photo_urls
        if (typeof existingPhotos === 'string') { try { existingPhotos = JSON.parse(existingPhotos) } catch { existingPhotos = [] } }
        const photos = Array.from(new Set([...(Array.isArray(existingPhotos) ? existingPhotos.filter((x:any) => typeof x === 'string' && x.trim()) : []),...body.completion_photo_urls.map((x:string) => x.trim())]))
        updated = (await client.query(`UPDATE property_deep_cleaning SET status='pending_review',review_status='pending',repair_photo_urls=$2::${cast},repair_notes=$3,started_at=$4::timestamptz,ended_at=$5::timestamptz,duration_minutes=$6,completed_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,[id,cast === 'jsonb' ? JSON.stringify(photos) : photos,body.completion_note?.trim() || null,start || null,end || null,duration])).rows[0]
      } else {
        price = deepCleaningReviewPrice(body)
        if (body.assignee_id !== undefined && row.assignee_id && body.assignee_id !== row.assignee_id) throw new WorkflowError(409,'deep_cleaning_assignee_conflict')
        if (!row.assignee_id) {
          const assignee = await rolesFor(client,String(body.assignee_id || ''))
          if (!assignee || !isDeepCleaningExecutorEligibleRoleNames(assignee.roles)) throw new WorkflowError(400,'task_assignee_invalid')
          row = (await client.query('UPDATE property_deep_cleaning SET assignee_id=$2,worker_name=$3 WHERE id=$1 RETURNING *',[id,body.assignee_id,assignee.display_name || assignee.username || assignee.id])).rows[0]
        }
        if (body.review_notes != null && (typeof body.review_notes !== 'string')) throw new WorkflowError(400,'deep_cleaning_note_invalid')
        updated = (await client.query(`UPDATE property_deep_cleaning SET status='completed',review_status='approved',total_cost=$2,pay_method=$3,gst_type=$4,reviewed_by=$5,reviewed_at=now(),review_notes=$6,updated_at=now() WHERE id=$1 RETURNING *`,[id,price.total_amount,price.pay_method,price.gst_type,actorId(user),body.review_notes?.trim() || null])).rows[0]
        // Expense failure rolls back status, price, event and receipt. No savepoint swallow.
        await syncDeepCleaningReviewedExpenseWithClient(client,updated)
      }
      if (price) await client.query(`INSERT INTO audit_logs(id,entity,entity_id,action,actor_id,before_json,after_json,created_at)
        VALUES($1,'property_deep_cleaning',$2,'deep_cleaning_review',$3,$4::jsonb,$5::jsonb,now())`,
        [require('uuid').v4(),id,actorId(user),JSON.stringify({status:row.status,review_status:row.review_status}),JSON.stringify({deep_cleaning_review:price})])
      const workId = `property_deep_cleaning:${id}`
      const projectedStatus = action === 'review' ? 'done' : updated.status
      await client.query(`INSERT INTO work_tasks(id,task_kind,source_type,source_id,property_id,title,summary,scheduled_date,assignee_id,status,urgency,photo_urls,completion_photo_urls,completion_note,created_at,updated_at)
        VALUES($1,'deep_cleaning','property_deep_cleaning',$2,$3,$4,$5,$6::date,$7,$8,$9,$10::jsonb,$11::jsonb,$12,now(),now())
        ON CONFLICT(source_type,source_id) DO UPDATE SET assignee_id=EXCLUDED.assignee_id,scheduled_date=EXCLUDED.scheduled_date,status=EXCLUDED.status,photo_urls=EXCLUDED.photo_urls,completion_photo_urls=EXCLUDED.completion_photo_urls,completion_note=EXCLUDED.completion_note,updated_at=now()`,
        [workId,id,updated.property_id,updated.work_no || id,updated.project_desc || updated.details || null,updated.eta,updated.assignee_id,projectedStatus,updated.urgency || 'normal',JSON.stringify(updated.photo_urls || []),JSON.stringify(updated.repair_photo_urls || []),updated.repair_notes || null])
      const output = deepCleaningWorkflowResponse({...updated,...(price || {}),media_access_work_task_id:(await deepCleaningMediaContexts(client,[updated])).get(id) || null},authenticatedActor,canAssign)
      const visibilityHints = buildWorkTaskVisibilityHints(updated)
      visibilityHints.user_ids = Array.from(new Set([...(visibilityHints.user_ids || []),row.assignee_id,updated.assignee_id].filter(Boolean)))
      const event = await emitWorkTaskEvent({taskId:`work_task:${workId}`,sourceType:'property_deep_cleaning',sourceRefIds:[id],eventType:action === 'assign' ? 'TASK_ASSIGNMENT_CHANGED' : 'TASK_UPDATED',changeScope:action === 'assign' ? 'membership' : 'list',changedFields:['status','assignee_id','photo_urls','completion_photo_urls','deep_cleaning_workflow'],patch:{status:projectedStatus,assignee_id:updated.assignee_id,photo_urls:updated.photo_urls,completion_photo_urls:updated.repair_photo_urls},payload:{deep_cleaning_action:action},causedByUserId:actorId(user),visibilityHints},client)
      if (!event) throw new Error('deep_cleaning_events_not_ready')
      await saveIdempotentStepReceipt(client,scope,hash,output)
      if (createdReport) committedNotice = {kind:'report',row:updated}
      else if (action === 'assign') committedNotice = {kind:'assignment',before:row,row:updated}
      return output
    })
    // Notification failures never turn committed business success into a retryable save error.
    // Receipt replay does not schedule another notice. Existing notification writer dedupes event IDs.
    if (committedNotice) {
      try {
        const saved = committedNotice.row
        if (committedNotice.kind === 'report') {
          await require('./mzapp').notifyPropertyFeedbackCreated({id:saved.id,kind:'deep_cleaning',propertyId:saved.property_id,sourceTaskId:saved.source_task_id,photoUrls:saved.photo_urls,summary:saved.details || saved.project_desc,actorUserId:actorId(user)})
        } else {
          const workId = `property_deep_cleaning:${id}`
          const before = {...committedNotice.before,id:workId,task_kind:'deep_cleaning',scheduled_date:committedNotice.before.eta,title:committedNotice.before.work_no || id,summary:committedNotice.before.project_desc || committedNotice.before.details}
          const diff = require('./task_center').buildWorkSaveDiff(before,{task_id:workId,assignee_assignment_action:'assign',assignee_id:saved.assignee_id,scheduled_date:saved.eta,title:before.title,summary:before.summary,urgency:saved.urgency})
          if (diff?.pushChanges.length && diff.pushRecipientUserIds.length) await require('../services/notificationEvents').emitNotificationEvent({type:'WORK_TASK_UPDATED',policyKey:'work_task_updated',entity:'work_task',entityId:workId,eventId:`WORK_TASK_UPDATED_work_task_${id}_${body.operation_id}`,propertyId:saved.property_id,updatedAt:String(saved.updated_at),title:'任务安排已更新',body:`任务：${saved.work_no || id}`,changes:diff.pushChanges,data:{entity:'work_task',entityId:workId,action:'open_work_task',kind:'work_task_updated',task_id:workId,task_title:saved.work_no || id,task_summary:before.summary,task_date:saved.eta,assignee_id:saved.assignee_id,assignee_name:saved.worker_name,status:saved.status},priority:diff.priority,actorUserId:actorId(user),recipientUserIds:diff.pushRecipientUserIds},{operationId:body.operation_id})
        }
      } catch { /* Business state is committed; notification persistence/delivery remains best-effort, as in the existing producer. */ }
    }
    return res.json(response)
  } catch(e) { return fail(res,e) }
})
