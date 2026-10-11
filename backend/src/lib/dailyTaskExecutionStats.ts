import {
  dailyTaskExecutionVisibility,
  isTurnoverDailyExecutionTask,
  type DailyTaskExecutionCandidate,
} from './dailyTaskExecutionVisibility'

export type DailyTaskStatsGroup = 'turnover' | 'offline'

export type DailyTaskStatsProjection = {
  daily_stats_group: DailyTaskStatsGroup | null
  daily_stats_key: string | null
}

type DailyTaskStatsCandidate = DailyTaskExecutionCandidate & {
  id?: unknown
  item_key?: unknown
  source_id?: unknown
  property_id?: unknown
  property_code?: unknown
  property?: { id?: unknown; code?: unknown } | null
  title?: unknown
}

function text(value: unknown) {
  return String(value ?? '').trim()
}

function taskDate(task: DailyTaskStatsCandidate) {
  const value = Object.prototype.hasOwnProperty.call(task, 'scheduled_date')
    ? task.scheduled_date
    : (task.task_date || task.date)
  return text(value).slice(0, 10)
}

function turnoverPropertyKey(task: DailyTaskStatsCandidate) {
  return text(task.property_id || task.property?.id || task.property_code || task.property?.code || task.title)
}

function offlineIdentity(task: DailyTaskStatsCandidate) {
  const sourceType = text(task.source_type) || 'task'
  const sourceId = text(task.source_id || task.id || task.item_key)
  return sourceId ? `${sourceType}:${sourceId}` : ''
}

/**
 * Adds count/dedupe metadata without redefining execution visibility.
 * MZ-021 remains the only authority for review, terminal, scheduling,
 * assignment and source-workflow semantics.
 */
export function projectDailyTaskStats(task: DailyTaskStatsCandidate): DailyTaskStatsProjection {
  if (!dailyTaskExecutionVisibility(task).visible) {
    return { daily_stats_group: null, daily_stats_key: null }
  }
  const date = taskDate(task)
  if (isTurnoverDailyExecutionTask(task)) {
    const propertyKey = turnoverPropertyKey(task)
    return {
      daily_stats_group: date && propertyKey ? 'turnover' : null,
      daily_stats_key: date && propertyKey ? `turnover:${date}:${propertyKey}` : null,
    }
  }
  const identity = offlineIdentity(task)
  return {
    daily_stats_group: date && identity ? 'offline' : null,
    daily_stats_key: date && identity ? `offline:${date}:${identity}` : null,
  }
}

export function countDailyTaskGroups(tasks: DailyTaskStatsCandidate[]) {
  const keys = {
    turnover: new Set<string>(),
    offline: new Set<string>(),
  }
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const projected = projectDailyTaskStats(task)
    if (projected.daily_stats_group && projected.daily_stats_key) {
      keys[projected.daily_stats_group].add(projected.daily_stats_key)
    }
  }
  return { turnover: keys.turnover.size, offline: keys.offline.size }
}
