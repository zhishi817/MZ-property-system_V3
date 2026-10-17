"use client"

import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import s from './HomeHeader.module.css'
import { SITE_NAV_ITEMS, isCurrentSiteNavigationItem } from './siteNavigation'

export default function HomeHeader() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [compact, setCompact] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const navRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const onScroll = () => setCompact(window.scrollY > 32)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    setOpen(false)
  }, [pathname])

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const focusable = [...(navRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') || [])]
    focusable[0]?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        window.requestAnimationFrame(() => triggerRef.current?.focus())
        return
      }
      if (event.key !== 'Tab' || focusable.length < 2) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const close = () => setOpen(false)

  return (
    <header className={`${s.siteHeader} ${compact ? s.compact : ''}`} data-header data-site-header data-header-state={compact ? 'compact' : 'rest'}>
      <a className={s.brand} href="/" aria-label="MZ Property home" onClick={close}>
        <img src="/homepage/brand-source.png" alt="MZ Property" />
      </a>
      <button
        ref={triggerRef}
        className={`${s.iconButton} ${s.menuToggle}`}
        type="button"
        aria-expanded={open}
        aria-controls="mz-primary-nav"
        onClick={() => setOpen((value) => !value)}
      >
        <img className={open ? s.hiddenIcon : ''} src="/homepage/icon-menu.svg" alt="" />
        <img className={!open ? s.hiddenIcon : ''} src="/homepage/icon-close.svg" alt="" />
        <span className={s.srOnly}>{open ? 'Close navigation' : 'Open navigation'}</span>
      </button>
      <nav ref={navRef} className={`${s.primaryNav} ${open ? s.navOpen : ''}`} id="mz-primary-nav" aria-label="Primary navigation">
        {SITE_NAV_ITEMS.map(([href, label], index) => {
          const current = isCurrentSiteNavigationItem(pathname, href)
          return <a key={`${href}-${index}`} className={s.navLink} href={href} aria-current={current ? 'page' : undefined} onClick={close}>{label}</a>
        })}
        <a className={s.navCta} href="/properties" onClick={close}>
          <span>Find Properties</span><img src="/homepage/icon-arrow-right.svg" alt="" />
        </a>
      </nav>
    </header>
  )
}
