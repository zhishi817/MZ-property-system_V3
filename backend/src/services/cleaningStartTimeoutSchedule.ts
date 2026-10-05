type ScheduleTask = {
  start: () => void
}

type ScheduleFn = (
  expression: string,
  handler: () => Promise<void>,
  options?: { scheduled?: boolean },
) => ScheduleTask

type QueryExecutor = {
  query: (sql: string, params?: any[]) => Promise<any>
}

type Logger = Pick<Console, 'log' | 'error'>

export type CleaningStartTimeoutScheduleDeps = {
  env?: NodeJS.ProcessEnv
  hasPg: boolean
  pgPool: QueryExecutor | null
  schedule: ScheduleFn
  logger?: Logger
  now?: () => number
}

export type CleaningStartTimeoutScheduleConfig = {
  explicitlyEnabled: boolean
  featureEnabled: boolean
  expression: string
  thresholdMinutes: number
}

function explicitlyEnabledBy(value: unknown) {
  return String(value ?? '').trim().toLowerCase() === 'true'
}

export function resolveCleaningStartTimeoutScheduleConfig(
  env: NodeJS.ProcessEnv = process.env,
): CleaningStartTimeoutScheduleConfig {
  return {
    explicitlyEnabled: explicitlyEnabledBy(env.CLEANING_START_TIMEOUT_ENABLED),
    featureEnabled: String(env.FEATURE_CLEANING_APP || 'false').toLowerCase() === 'true',
    expression: String(env.CLEANING_START_TIMEOUT_CRON || '*/15 * * * *'),
    thresholdMinutes: Number(env.CLEANING_START_TIMEOUT_MINUTES || 60),
  }
}

export function registerCleaningStartTimeoutSchedule(
  deps: CleaningStartTimeoutScheduleDeps,
): ScheduleTask | null {
  const env = deps.env || process.env
  const logger = deps.logger || console
  const config = resolveCleaningStartTimeoutScheduleConfig(env)

  if (!config.explicitlyEnabled) {
    logger.log('[cleaning-timeout][schedule] disabled reason=flag_disabled')
    return null
  }
  if (!config.featureEnabled) {
    logger.log('[cleaning-timeout][schedule] disabled reason=cleaning_feature_disabled')
    return null
  }
  if (!deps.hasPg || !deps.pgPool) {
    logger.log('[cleaning-timeout][schedule] disabled reason=pg_unavailable')
    return null
  }

  const task = deps.schedule(
    config.expression,
    async () => {
      try {
        const sql = `select id, assignee_id, scheduled_at, key_photo_uploaded_at from cleaning_tasks where date=now()::date and status='scheduled'`
        const rs = await deps.pgPool!.query(sql)
        for (const row of rs?.rows || []) {
          const scheduledAt = row.scheduled_at ? new Date(row.scheduled_at) : null
          if (!scheduledAt || row.key_photo_uploaded_at) continue
          const diff = (deps.now || Date.now)() - scheduledAt.getTime()
          if (diff > config.thresholdMinutes * 60 * 1000) {
            logger.log(`[cleaning-timeout] task=${row.id} assignee=${row.assignee_id} overdue_minutes=${Math.round(diff / 60000)}`)
          }
        }
      } catch (error: any) {
        logger.error(`[cleaning-timeout] error message=${String(error?.message || '')}`)
      }
    },
    { scheduled: true },
  )
  task.start()
  logger.log(`[cleaning-timeout][schedule] enabled cron=${config.expression} threshold_minutes=${config.thresholdMinutes}`)
  return task
}
