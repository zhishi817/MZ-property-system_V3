"use client"

import Link from 'next/link'
import BookingLayout from '../BookingLayout'
import styles from '../booking.module.css'
import { useSiteCopy } from '../siteContext'

function InquirySuccessContent() {
  const { t } = useSiteCopy()

  return (
    <section className={styles.section}>
      <div className={styles.shell}>
        <div className={`${styles.panel} ${styles.successPanel}`}>
          <div className={styles.inquiryBadge}>{t.inquiryReceived}</div>
          <h1 className={styles.sectionTitle}>{t.inquirySent}</h1>
          <p className={styles.sectionSubtitle}>{t.inquirySentSubtitle}</p>
          <div className={styles.successActions}>
            <Link href="/properties" className={`${styles.cta} ${styles.ctaPrimary}`}>
              {t.browseMore}
            </Link>
            <Link href="/" className={`${styles.cta} ${styles.ctaSecondary}`}>
              {t.backHome}
            </Link>
          </div>
        </div>
      </div>
    </section>
  )
}

export default function Page() {
  return (
    <BookingLayout>
      <InquirySuccessContent />
    </BookingLayout>
  )
}
