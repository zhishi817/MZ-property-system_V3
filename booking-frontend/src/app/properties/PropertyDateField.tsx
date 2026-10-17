"use client"

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { addIsoCalendarDays, formatHomepageStayDate } from '../../lib/homepage'
import styles from './properties.module.css'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function isoDate(year: number, monthIndex: number, day: number) {
  const date = new Date(Date.UTC(year, monthIndex, day, 12))
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
    .join('-')
}

function isoParts(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return { year, month, day }
}

function startOfMonth(value: string) {
  const { year, month } = isoParts(value)
  return isoDate(year, month - 1, 1)
}

function addIsoMonths(value: string, amount: number) {
  const { year, month, day } = isoParts(value)
  const lastDay = new Date(Date.UTC(year, month + amount, 0, 12)).getUTCDate()
  return isoDate(year, month - 1 + amount, Math.min(day, lastDay))
}

function calendarDays(monthValue: string) {
  const first = startOfMonth(monthValue)
  const { year, month } = isoParts(first)
  const weekday = new Date(Date.UTC(year, month - 1, 1, 12)).getUTCDay()
  const firstCell = addIsoCalendarDays(first, -weekday)
  return Array.from({ length: 42 }, (_, index) => addIsoCalendarDays(firstCell, index))
}

function monthTitle(value: string) {
  const { year, month } = isoParts(value)
  return new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric', timeZone: 'Australia/Melbourne' })
    .format(new Date(Date.UTC(year, month - 1, 1, 12)))
}

function accessibleDate(value: string) {
  const { year, month, day } = isoParts(value)
  return new Intl.DateTimeFormat('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Australia/Melbourne',
  }).format(new Date(Date.UTC(year, month - 1, day, 12)))
}

function weekdayIndex(value: string) {
  const { year, month, day } = isoParts(value)
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay()
}

export default function PropertyDateField({
  id,
  label,
  value,
  min,
  today,
  error,
  onChange,
}: {
  id: string
  label: string
  value: string
  min: string
  today: string
  error?: string
  onChange: (value: string) => void
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const dayRefs = useRef(new Map<string, HTMLButtonElement>())
  const seed = value && value >= min ? value : min
  const [open, setOpen] = useState(false)
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(seed))
  const [focusDate, setFocusDate] = useState(seed)
  const days = useMemo(() => calendarDays(visibleMonth), [visibleMonth])
  const labelId = `${id}-label`
  const errorId = `${id}-error`
  const dialogId = `${id}-calendar`

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => dayRefs.current.get(focusDate)?.focus({ preventScroll: true }))
    return () => window.cancelAnimationFrame(frame)
  }, [focusDate, open, visibleMonth])

  function openCalendar() {
    const nextSeed = value && value >= min ? value : min
    setVisibleMonth(startOfMonth(nextSeed))
    setFocusDate(nextSeed)
    setOpen(true)
  }

  function closeCalendar(returnFocus = false) {
    setOpen(false)
    if (returnFocus) window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }

  function chooseDate(nextValue: string) {
    if (nextValue < min) return
    onChange(nextValue)
    closeCalendar(true)
  }

  function moveFocus(nextValue: string) {
    const allowed = nextValue < min ? min : nextValue
    setFocusDate(allowed)
    setVisibleMonth(startOfMonth(allowed))
  }

  function handleDayKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    let next = ''
    if (event.key === 'ArrowLeft') next = addIsoCalendarDays(focusDate, -1)
    if (event.key === 'ArrowRight') next = addIsoCalendarDays(focusDate, 1)
    if (event.key === 'ArrowUp') next = addIsoCalendarDays(focusDate, -7)
    if (event.key === 'ArrowDown') next = addIsoCalendarDays(focusDate, 7)
    if (event.key === 'Home') next = addIsoCalendarDays(focusDate, -weekdayIndex(focusDate))
    if (event.key === 'End') next = addIsoCalendarDays(focusDate, 6 - weekdayIndex(focusDate))
    if (event.key === 'PageUp') next = addIsoMonths(focusDate, -1)
    if (event.key === 'PageDown') next = addIsoMonths(focusDate, 1)
    if (!next) return
    event.preventDefault()
    moveFocus(next)
  }

  function changeMonth(amount: number) {
    const nextMonth = startOfMonth(addIsoMonths(visibleMonth, amount))
    const nextFocus = nextMonth < startOfMonth(min) ? min : nextMonth
    setVisibleMonth(startOfMonth(nextFocus))
    setFocusDate(nextFocus)
  }

  return (
    <div
      ref={rootRef}
      className={styles.dateField}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return
        event.preventDefault()
        closeCalendar(true)
      }}
    >
      <span className={styles.fieldLabel} id={labelId}>{label}</span>
      <button
        ref={triggerRef}
        id={id}
        className={styles.fieldButton}
        type="button"
        data-value={value}
        data-invalid={error ? 'true' : 'false'}
        aria-labelledby={`${labelId} ${id}-value`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        aria-describedby={error ? errorId : undefined}
        onClick={() => open ? closeCalendar() : openCalendar()}
      >
        <span id={`${id}-value`}>{formatHomepageStayDate(value)}</span>
        <img src="/homepage/icon-arrow-right.svg" alt="" />
      </button>
      <small className={styles.fieldHint}>{error || 'DD MMM YYYY'}</small>
      {open ? (
        <div className={styles.datePopover} id={dialogId} role="dialog" aria-modal="false" aria-labelledby={`${id}-calendar-title`}>
          <div className={styles.calendarHeader}>
            <button type="button" aria-label="Show previous month" disabled={visibleMonth <= startOfMonth(min)} onClick={() => changeMonth(-1)}>
              <img src="/homepage/icon-arrow-left.svg" alt="" />
            </button>
            <strong id={`${id}-calendar-title`}>{monthTitle(visibleMonth)}</strong>
            <button type="button" aria-label="Show next month" onClick={() => changeMonth(1)}>
              <img src="/homepage/icon-arrow-right.svg" alt="" />
            </button>
          </div>
          <p className={styles.calendarHint}>Choose {label.toLowerCase()} · Melbourne time</p>
          <div className={styles.calendarWeekdays} aria-hidden="true">
            {WEEKDAYS.map((weekday) => <span key={weekday}>{weekday}</span>)}
          </div>
          <div className={styles.calendarDays} role="grid" aria-label={`${label}, ${monthTitle(visibleMonth)}`}>
            {days.map((day) => {
              const outside = startOfMonth(day) !== visibleMonth
              const selected = day === value
              return (
                <button
                  key={day}
                  ref={(element) => {
                    if (element) dayRefs.current.set(day, element)
                    else dayRefs.current.delete(day)
                  }}
                  type="button"
                  role="gridcell"
                  className={`${styles.calendarDay} ${outside ? styles.calendarDayOutside : ''} ${selected ? styles.calendarDaySelected : ''}`}
                  data-date={day}
                  tabIndex={day === focusDate ? 0 : -1}
                  disabled={day < min}
                  aria-label={accessibleDate(day)}
                  aria-selected={selected}
                  aria-current={day === today ? 'date' : undefined}
                  onKeyDown={handleDayKeyDown}
                  onClick={() => chooseDate(day)}
                >
                  {isoParts(day).day}
                </button>
              )
            })}
          </div>
          <div className={styles.calendarFooter}>
            <button type="button" disabled={!value} onClick={() => { onChange(''); closeCalendar(true) }}>Clear date</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
