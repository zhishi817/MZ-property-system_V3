"use client"

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import styles from './booking.module.css'
import { SiteCopyProvider, useSiteCopy } from './siteContext'

function BookingChrome({ children }: { children: ReactNode }) {
  const { t } = useSiteCopy()
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)

  const menuItems = [
    { href: '/', label: t.navHome },
    { href: '/#about', label: t.navStory },
    { href: '/properties', label: t.navProperties },
    { href: '/#listing', label: t.navListing },
    { href: '/#contact', label: t.navContact },
  ]

  function navigateTo(href: string) {
    setMenuOpen(false)
    window.setTimeout(() => {
      if (href.startsWith('/#')) {
        if (window.location.pathname !== '/') {
          router.push(href)
          return
        }
        const id = href.slice(2)
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        window.history.replaceState(null, '', href)
        return
      }
      router.push(href)
    }, 10)
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={`${styles.shell} ${styles.headerInner}`}>
          <Link href="/" className={styles.brand}>
            <img className={styles.logoImage} src="/mz-logo.png" alt="MZ Property" />
          </Link>
          <nav className={styles.nav}>
            <button type="button" className={styles.navIcon} aria-label={t.navListing} onClick={() => setMenuOpen(true)}>
              <span className={styles.navIconGlyph} aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            </button>
          </nav>
        </div>
      </header>

      {menuOpen ? (
        <div className={styles.overlay} onClick={() => setMenuOpen(false)}>
          <div className={styles.menuPanel} onClick={(e) => e.stopPropagation()}>
            {menuItems.map((item) => (
              <button key={item.href} type="button" className={styles.menuItem} onClick={() => navigateTo(item.href)}>
                {item.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {children}

      <footer className={styles.footer}>
        <div className={styles.shell}>
          <div>{t.footerTitle}</div>
          <div className={styles.footerSubtitle}>{t.footerSubtitle}</div>
        </div>
      </footer>
    </div>
  )
}

export default function BookingLayout({ children }: { children: ReactNode }) {
  return (
    <SiteCopyProvider>
      <BookingChrome>{children}</BookingChrome>
    </SiteCopyProvider>
  )
}
