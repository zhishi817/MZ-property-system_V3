"use client"

import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import s from './home.module.css'

export type EnglishSelectOption = { value: string; label: string }

type EnglishSelectProps = {
  id: string
  label: string
  value: string
  options: readonly EnglishSelectOption[]
  open: boolean
  align?: 'left' | 'right'
  error?: string
  className?: string
  hint?: string
  hintClassName?: string
  triggerRef: RefObject<HTMLButtonElement>
  onOpenChange: (open: boolean) => void
  onChange: (value: string) => void
}

export default function EnglishSelect({ id, label, value, options, open, align = 'left', error, className = '', hint, hintClassName = '', triggerRef, onOpenChange, onChange }: EnglishSelectProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const onOpenChangeRef = useRef(onOpenChange)
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))
  const [activeIndex, setActiveIndex] = useState(selectedIndex)
  const listboxId = `${id}-listbox`
  const labelId = `${id}-label`
  const valueId = `${id}-value`
  const errorId = `${id}-error`
  const selected = options[selectedIndex] || options[0]

  useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  }, [onOpenChange])

  useEffect(() => {
    if (!open) return
    let frame = 0
    const ensureVisible = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const popup = rootRef.current?.querySelector<HTMLElement>('[role="listbox"]')
        if (!popup) return
        const rect = popup.getBoundingClientRect()
        const headerBottom = document.querySelector<HTMLElement>('[data-header]')?.getBoundingClientRect().bottom || 0
        const topGuard = headerBottom + 10
        const bottomGuard = window.innerHeight - 12
        if (rect.top < topGuard) window.scrollBy({ top: rect.top - topGuard, behavior: 'auto' })
        else if (rect.bottom > bottomGuard) window.scrollBy({ top: rect.bottom - bottomGuard, behavior: 'auto' })
      })
    }
    const handleOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChangeRef.current(false)
    }
    ensureVisible()
    document.addEventListener('pointerdown', handleOutside)
    window.addEventListener('resize', ensureVisible)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', handleOutside)
      window.removeEventListener('resize', ensureVisible)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus({ preventScroll: true }))
    return () => window.cancelAnimationFrame(frame)
  }, [activeIndex, open])

  function openAt(index: number) {
    setActiveIndex(Math.max(0, Math.min(options.length - 1, index)))
    onOpenChange(true)
  }

  function close(returnFocus = false) {
    onOpenChange(false)
    if (returnFocus) window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }

  function choose(index: number) {
    const option = options[index]
    if (!option) return
    onChange(option.value)
    close(true)
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      openAt(open ? activeIndex + 1 : selectedIndex + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      openAt(open ? activeIndex - 1 : selectedIndex - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      openAt(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      openAt(options.length - 1)
    } else if ((event.key === 'Enter' || event.key === ' ') && open) {
      event.preventDefault()
      choose(activeIndex)
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      close(true)
    }
  }

  function handleOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index + 1) % options.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index - 1 + options.length) % options.length)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(options.length - 1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      choose(index)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
    } else if (event.key === 'Tab') {
      onOpenChange(false)
    }
  }

  return (
    <div
      ref={rootRef}
      className={`${s.searchField} ${s.selectField} ${className}`.trim()}
      onKeyDown={(event) => {
        if (event.key === 'Tab' && open) onOpenChange(false)
      }}
    >
      <span id={labelId}>{label}</span>
      <button
        ref={triggerRef}
        id={id}
        className={s.selectTrigger}
        type="button"
        data-value={value}
        data-invalid={error ? 'true' : 'false'}
        aria-labelledby={`${labelId} ${valueId}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-describedby={error ? errorId : undefined}
        onClick={() => open ? close() : openAt(selectedIndex)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span id={valueId}>{selected?.label}</span>
        <img className={s.selectTriggerIcon} src="/homepage/icon-arrow-right.svg" alt="" />
      </button>
      {error ? <small id={errorId}>{error}</small> : null}
      {hint ? <small className={hintClassName}>{hint}</small> : null}
      {open ? (
        <div className={`${s.selectPopover} ${align === 'right' ? s.selectPopoverRight : ''}`} id={listboxId} role="listbox" aria-labelledby={labelId}>
          {options.map((option, index) => (
            <button
              key={option.value}
              ref={(element) => { optionRefs.current[index] = element }}
              className={`${s.selectOption} ${option.value === value ? s.selectOptionSelected : ''}`}
              type="button"
              role="option"
              aria-selected={option.value === value}
              tabIndex={index === activeIndex ? 0 : -1}
              onClick={() => choose(index)}
              onKeyDown={(event) => handleOptionKeyDown(event, index)}
            >
              <span>{option.label}</span>
              {option.value === value ? <span className={s.selectedLabel}>Selected</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
