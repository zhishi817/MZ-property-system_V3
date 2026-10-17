"use client"

import type { ReactNode } from 'react'
import styles from './booking.module.css'
import HomeHeader from './home/HomeHeader'
import { SiteCopyProvider, useSiteCopy } from './siteContext'

function BookingChrome({ children }: { children: ReactNode }) {
  const { t } = useSiteCopy()

  return (
    <div className={styles.page}>
      <HomeHeader />

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
