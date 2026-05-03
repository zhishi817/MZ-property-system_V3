"use client"

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import type { FormEvent } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { getJSON, postJSON, resolveAssetUrl } from '../../../lib/api'
import type { GuestSiteAvailability, GuestSiteProperty } from '../../../lib/guestSite'
import styles from '../../booking.module.css'
import { useSiteCopy } from '../../siteContext'

function toIsoDate(date: Date) {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseIsoDate(value: string) {
  if (!value) return null
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return null
  return new Date(year, month - 1, day)
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function addMonths(date: Date, amount: number) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1)
}

function sameDay(a: Date | null, b: Date | null) {
  return !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function buildMonthDays(month: Date) {
  const first = startOfMonth(month)
  const start = new Date(first)
  start.setDate(1 - first.getDay())
  const days: Date[] = []
  for (let i = 0; i < 42; i += 1) {
    const next = new Date(start)
    next.setDate(start.getDate() + i)
    days.push(next)
  }
  return days
}

function formatMonthTitle(date: Date, locale: string) {
  if (locale === 'zh' || locale === 'zh-Hant') return `${date.getFullYear()}年 ${date.getMonth() + 1}月`
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(date)
}

function formatDateDisplay(value: string, locale: string) {
  const date = parseIsoDate(value)
  if (!date) return locale === 'zh' || locale === 'zh-Hant' ? '添加日期' : 'Add dates'
  if (locale === 'zh' || locale === 'zh-Hant') {
    return `${date.getMonth() + 1}月 ${String(date.getDate()).padStart(2, '0')}`
  }
  return new Intl.DateTimeFormat('en-AU', { month: 'short', day: '2-digit' }).format(date)
}

function inferDetailMeta(property: GuestSiteProperty) {
  return {
    guests: property.public_capacity_override || property.capacity || 0,
    bedrooms: property.bedroom_count || 0,
    bathrooms: property.bathroom_count || 0,
    beds: property.bed_count || 0,
  }
}

const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function PropertyDetailClient({
  propertyId,
  initialProperty,
}: {
  propertyId: string
  initialProperty: GuestSiteProperty | null
}) {
  const { locale, t } = useSiteCopy()
  const searchParams = useSearchParams()
  const [property] = useState<GuestSiteProperty | null>(initialProperty)
  const [loaded] = useState(true)
  const [availability, setAvailability] = useState<GuestSiteAvailability | null>(null)
  const [showInquiry, setShowInquiry] = useState(false)
  const [showAllPhotos, setShowAllPhotos] = useState(false)
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(new Date()))
  const [activeDateField, setActiveDateField] = useState<'checkin' | 'checkout'>('checkin')
  const [form, setForm] = useState({
    guest_name: '',
    guest_phone: '',
    guest_email: '',
    checkin: searchParams.get('checkin') || '',
    checkout: searchParams.get('checkout') || '',
    guest_count: searchParams.get('guests') || '1',
    message: '',
  })
  const [submitError, setSubmitError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const previewMode = searchParams.get('preview') === '1'

  useEffect(() => {
    const params = new URLSearchParams()
    if (form.checkin) params.set('checkin', form.checkin)
    if (form.checkout) params.set('checkout', form.checkout)
    if (previewMode) params.set('preview', '1')
    getJSON<GuestSiteAvailability>(`/public/guest-site/properties/${encodeURIComponent(propertyId)}/availability?${params.toString()}`)
      .then((row) => setAvailability(row))
      .catch(() => setAvailability(null))
  }, [form.checkin, form.checkout, previewMode, propertyId])

  const gallery = useMemo(() => {
    const images = Array.isArray(property?.gallery_urls) ? property.gallery_urls : []
    const resolved = images.map((item) => resolveAssetUrl(item)).filter(Boolean)
    const fallback = resolveAssetUrl(property?.hero_image_url || '')
    return resolved.length ? resolved : fallback ? [fallback] : []
  }, [property])

  const weekdays = WEEKDAYS_EN
  const checkinDate = parseIsoDate(form.checkin)
  const checkoutDate = parseIsoDate(form.checkout)
  const months = [visibleMonth, addMonths(visibleMonth, 1)]
  const meta = property ? inferDetailMeta(property) : null
  const locationLabel = useMemo(() => {
    return String(property?.location_note || property?.public_region_label || property?.region || 'Melbourne, Victoria, Australia').trim()
  }, [property?.location_note, property?.public_region_label, property?.region])
  const mapUrl = useMemo(() => {
    const target = String(locationLabel || '').trim()
    return target ? `https://www.google.com/maps?q=${encodeURIComponent(target)}&output=embed` : ''
  }, [locationLabel])
  const panelHighlights = Array.isArray(property?.booking_highlights) && property.booking_highlights.length
    ? property.booking_highlights
    : locale === 'zh' || locale === 'zh-Hant'
      ? ['人工确认可订性', '支持长住与企业入住咨询']
      : ['Availability confirmed manually', 'Extended stays available on request']

  function handleDatePick(date: Date) {
    const picked = toIsoDate(date)
    setForm((prev) => {
      if (activeDateField === 'checkin') {
        return {
          ...prev,
          checkin: picked,
          checkout: prev.checkout && prev.checkout < picked ? '' : prev.checkout,
        }
      }
      if (!prev.checkin || picked < prev.checkin) {
        return { ...prev, checkin: picked, checkout: '' }
      }
      return { ...prev, checkout: picked }
    })
    setActiveDateField((prev) => (prev === 'checkin' ? 'checkout' : 'checkin'))
  }

  function isInRange(date: Date) {
    if (!checkinDate || !checkoutDate) return false
    return date > checkinDate && date < checkoutDate
  }

  function clearDates() {
    setForm((prev) => ({ ...prev, checkin: '', checkout: '' }))
    setActiveDateField('checkin')
  }

  async function submitInquiry(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setSubmitError('')
    try {
      await postJSON('/public/guest-site/inquiries', {
        property_id: propertyId,
        guest_name: form.guest_name,
        guest_phone: form.guest_phone,
        guest_email: form.guest_email,
        checkin: form.checkin,
        checkout: form.checkout,
        guest_count: Number(form.guest_count || 1),
        message: form.message,
      })
      setShowInquiry(false)
      window.location.href = '/inquiry-success'
    } catch (e: any) {
      setSubmitError(String(e?.message || t.submitError))
    } finally {
      setSubmitting(false)
    }
  }

  if (!loaded) {
    return (
      <section className={styles.section}>
        <div className={styles.shell}>
          <div className={styles.empty}>{locale === 'zh' || locale === 'zh-Hant' ? '正在加载房源...' : 'Loading property...'}</div>
        </div>
      </section>
    )
  }

  if (!property || !meta) {
    return (
      <section className={styles.section}>
        <div className={styles.shell}>
          <div className={styles.empty}>{t.propertyNotFound}</div>
        </div>
      </section>
    )
  }

  return (
    <section className={styles.detailPageSection}>
      <div className={styles.shell}>
        <div className={styles.detailBackRow}>
          <nav className={styles.breadcrumbs} aria-label="Breadcrumb">
            <Link href="/" className={styles.breadcrumbLink}>
              {t.navHome}
            </Link>
            <span className={styles.breadcrumbSeparator}>/</span>
            <Link href="/properties" className={styles.breadcrumbLink}>
              {t.navProperties}
            </Link>
            <span className={styles.breadcrumbSeparator}>/</span>
            <span className={styles.breadcrumbCurrent}>{property.hero_title}</span>
          </nav>
        </div>

        <div className={styles.detailHeroGallery}>
          <div className={styles.detailHeroMain}>
            {gallery[0] ? <img className={styles.detailHeroMainImage} src={gallery[0]} alt={property.hero_title} /> : null}
          </div>
          <div className={styles.detailHeroSide}>
            {gallery.slice(1, 5).map((url, idx) => (
              <div key={`${url}-${idx}`} className={styles.detailHeroThumb}>
                <img className={styles.detailHeroThumbImage} src={url} alt={`${property.hero_title} ${idx + 2}`} />
              </div>
            ))}
            {gallery.length > 4 ? (
              <button type="button" className={styles.detailGalleryButton} onClick={() => setShowAllPhotos(true)}>
                {locale === 'zh' || locale === 'zh-Hant' ? '显示全部照片' : 'Show all photos'}
              </button>
            ) : null}
          </div>
        </div>

        <div className={styles.detailLayout}>
          <div className={styles.detailMainColumn}>
            <section className={styles.detailCardSection}>
              <h1 className={styles.detailMainTitle}>{property.hero_title}</h1>
              <div className={styles.detailMetaLine}>
                <span>{property.type || (locale === 'zh' || locale === 'zh-Hant' ? '整套房源' : 'Entire place')}</span>
                <span>·</span>
                <span>{meta.guests}{locale === 'zh' || locale === 'zh-Hant' ? ' 房客' : ' guests'}</span>
                <span>·</span>
                <span>{meta.bedrooms}{locale === 'zh' || locale === 'zh-Hant' ? ' 卧室' : ' bedrooms'}</span>
                <span>·</span>
                <span>{meta.bathrooms}{locale === 'zh' || locale === 'zh-Hant' ? ' 浴室' : ' bathrooms'}</span>
                <span>·</span>
                <span>{meta.beds}{locale === 'zh' || locale === 'zh-Hant' ? ' 床' : ' beds'}</span>
              </div>
            </section>

            <section className={styles.detailCardSection}>
              <div className={styles.detailSectionDivider} />
              <h2 className={styles.detailSectionHeading}>{t.propertyOverview}</h2>
              <p className={styles.detailParagraph}>{property.long_description || property.notes || t.overviewFallback}</p>
            </section>

            {property.feature_tags?.length ? (
              <section className={styles.detailCardSection}>
                <div className={styles.detailSectionDivider} />
                <h2 className={styles.detailSectionHeading}>{locale === 'zh' || locale === 'zh-Hant' ? '房源设置' : 'Property Setup'}</h2>
                <div className={styles.detailAmenityGrid}>
                  {property.feature_tags.map((item) => (
                    <div key={item} className={styles.detailAmenityItem}>
                      <span className={styles.detailAmenityDot} />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {property.amenities?.length ? (
              <section className={styles.detailCardSection}>
                <div className={styles.detailSectionDivider} />
                <h2 className={styles.detailSectionHeading}>{t.facilities}</h2>
                <div className={styles.detailAmenityGrid}>
                  {property.amenities.map((item) => (
                    <div key={item} className={styles.detailAmenityItem}>
                      <span className={styles.detailAmenityDot} />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section className={styles.detailCardSection}>
              <div className={styles.detailSectionDivider} />
              <div className={styles.detailAvailabilityHead}>
                <div>
                  <h2 className={styles.detailSectionHeading}>{locale === 'zh' || locale === 'zh-Hant' ? '可用性' : 'Availability'}</h2>
                  <div className={styles.detailMuted}>
                    {form.checkin && form.checkout
                      ? `${formatDateDisplay(form.checkin, locale)} ~ ${formatDateDisplay(form.checkout, locale)}`
                      : locale === 'zh' || locale === 'zh-Hant'
                        ? '请选择日期'
                        : 'Please choose dates'}
                  </div>
                </div>
              </div>
              <div className={styles.detailCalendarHeader}>
                <button type="button" className={styles.detailCalendarNav} onClick={() => setVisibleMonth((prev) => addMonths(prev, -1))}>
                  ‹
                </button>
                <button type="button" className={styles.detailCalendarClear} onClick={clearDates}>
                  {t.clearDates}
                </button>
              </div>
              <div className={styles.detailCalendarMonths}>
                {months.map((month) => {
                  const days = buildMonthDays(month)
                  return (
                    <div key={`${month.getFullYear()}-${month.getMonth()}`} className={styles.detailCalendarMonth}>
                      <div className={styles.detailCalendarMonthTitle}>{formatMonthTitle(month, locale)}</div>
                      <div className={styles.detailCalendarWeekdays}>
                        {weekdays.map((label) => (
                          <span key={`${month.getMonth()}-${label}`}>{label}</span>
                        ))}
                      </div>
                      <div className={styles.detailCalendarDays}>
                        {days.map((day) => {
                          const outside = day.getMonth() !== month.getMonth()
                          const isCheckin = sameDay(day, checkinDate)
                          const isCheckout = sameDay(day, checkoutDate)
                          return (
                            <button
                              key={toIsoDate(day)}
                              type="button"
                              className={[
                                styles.detailCalendarDay,
                                outside ? styles.detailCalendarDayMuted : '',
                                isCheckin || isCheckout ? styles.detailCalendarDaySelected : '',
                                isInRange(day) ? styles.detailCalendarDayInRange : '',
                              ].join(' ').trim()}
                              onClick={() => handleDatePick(day)}
                            >
                              {day.getDate()}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>

            <section className={styles.detailCardSection}>
              <div className={styles.detailSectionDivider} />
              <h2 className={styles.detailSectionHeading}>{locale === 'zh' || locale === 'zh-Hant' ? '位置' : 'Location'}</h2>
              {mapUrl ? <iframe className={styles.detailMapFrame} src={mapUrl} loading="lazy" referrerPolicy="no-referrer-when-downgrade" title="Property map" /> : null}
              <div className={styles.detailLocationText}>{locationLabel}</div>
            </section>

            {property.house_rules?.length ? (
              <section className={styles.detailCardSection}>
                <div className={styles.detailSectionDivider} />
                <h2 className={styles.detailSectionHeading}>{locale === 'zh' || locale === 'zh-Hant' ? '房屋守则' : 'House Rules'}</h2>
                <div className={styles.detailRulesList}>
                  {property.house_rules.map((item) => (
                    <div key={item} className={styles.detailRuleItem}>
                      <span className={styles.detailRuleDot} />
                      <span>{item}</span>
                    </div>
                  ))}
                  {property.checkin_time ? (
                    <div className={styles.detailRuleItem}>
                      <span className={styles.detailRuleDot} />
                      <span>{locale === 'zh' || locale === 'zh-Hant' ? `入住：${property.checkin_time}` : `Check in: ${property.checkin_time}`}</span>
                    </div>
                  ) : null}
                  {property.checkout_time ? (
                    <div className={styles.detailRuleItem}>
                      <span className={styles.detailRuleDot} />
                      <span>{locale === 'zh' || locale === 'zh-Hant' ? `退房：${property.checkout_time}` : `Check out: ${property.checkout_time}`}</span>
                    </div>
                  ) : null}
                </div>
              </section>
            ) : null}
          </div>

          <aside className={styles.detailSidebar}>
            <div className={styles.detailBookingCard}>
              <div className={styles.detailPriceLabel}>{property.price_label || (locale === 'zh' || locale === 'zh-Hant' ? '人工确认价格' : 'Price confirmed manually')}</div>
              <div className={styles.detailBookingGrid}>
                <button type="button" className={styles.detailBookingCell} onClick={() => setActiveDateField('checkin')}>
                  <span>{locale === 'zh' || locale === 'zh-Hant' ? '入住' : 'Check in'}</span>
                  <strong>{formatDateDisplay(form.checkin, locale)}</strong>
                </button>
                <button type="button" className={styles.detailBookingCell} onClick={() => setActiveDateField('checkout')}>
                  <span>{locale === 'zh' || locale === 'zh-Hant' ? '退房' : 'Check out'}</span>
                  <strong>{formatDateDisplay(form.checkout, locale)}</strong>
                </button>
                <label className={`${styles.detailBookingCell} ${styles.detailBookingCellWide}`}>
                  <span>{t.guests}</span>
                  <select
                    className={styles.detailGuestSelect}
                    value={form.guest_count}
                    onChange={(e) => setForm((prev) => ({ ...prev, guest_count: e.target.value }))}
                  >
                    {Array.from({ length: Math.max(meta.guests || 1, 8) }, (_, idx) => idx + 1).map((count) => (
                      <option key={count} value={count}>
                        {locale === 'zh' || locale === 'zh-Hant' ? `${count} 房客` : `${count} guests`}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className={styles.detailBookingSummary}>
                <div className={styles.detailBookingRow}>
                  <span>{locale === 'zh' || locale === 'zh-Hant' ? 'Default Rate' : 'Default Rate'}</span>
                  <strong>{property.price_label || (locale === 'zh' || locale === 'zh-Hant' ? '人工确认' : 'Manual quote')}</strong>
                </div>
                <div className={styles.detailBookingRow}>
                  <span>{locale === 'zh' || locale === 'zh-Hant' ? '总计 (AUD)' : 'Total (AUD)'}</span>
                  <strong>{property.price_label || (locale === 'zh' || locale === 'zh-Hant' ? '待确认' : 'To confirm')}</strong>
                </div>
              </div>
              <div className={styles.detailBookingNotes}>
                {panelHighlights.map((item) => (
                  <div key={item} className={styles.detailBookingNoteItem}>
                    <span className={styles.detailBookingCheck}>✓</span>
                    <span>{item}</span>
                  </div>
                ))}
                {availability?.available === true ? <div className={styles.statusOk}>{t.availableText}</div> : null}
                {availability?.available === false ? <div className={styles.statusBad}>{t.blockedText}</div> : null}
              </div>
              <div className={styles.detailBookingActions}>
                <button type="button" className={styles.detailGhostButton} onClick={() => clearDates()}>
                  {locale === 'zh' || locale === 'zh-Hant' ? '重置' : 'Reset'}
                </button>
                <button type="button" className={styles.detailPrimaryButton} onClick={() => setShowInquiry(true)}>
                  {locale === 'zh' || locale === 'zh-Hant' ? '申请预订' : 'Request Booking'}
                </button>
              </div>
            </div>
          </aside>
        </div>

        {showInquiry ? (
          <div className={styles.detailOverlay} onClick={() => setShowInquiry(false)}>
            <div className={styles.detailModal} onClick={(e) => e.stopPropagation()}>
              <button type="button" className={styles.detailModalClose} onClick={() => setShowInquiry(false)}>×</button>
              <h3 className={styles.detailModalTitle}>{locale === 'zh' || locale === 'zh-Hant' ? '提交询单' : 'Send inquiry'}</h3>
              <form onSubmit={submitInquiry} className={styles.detailInquiryForm}>
                <input className={styles.field} placeholder={t.fullName} value={form.guest_name} onChange={(e) => setForm((prev) => ({ ...prev, guest_name: e.target.value }))} required />
                <input className={styles.field} placeholder={t.phone} value={form.guest_phone} onChange={(e) => setForm((prev) => ({ ...prev, guest_phone: e.target.value }))} required />
                <input className={styles.field} type="email" placeholder={t.emailPlaceholder} value={form.guest_email} onChange={(e) => setForm((prev) => ({ ...prev, guest_email: e.target.value }))} required />
                <textarea className={styles.textarea} placeholder={t.messagePlaceholder} value={form.message} onChange={(e) => setForm((prev) => ({ ...prev, message: e.target.value }))} />
                {submitError ? <div className={styles.statusBad}>{submitError}</div> : null}
                <button className={styles.detailPrimaryButton} type="submit" disabled={submitting}>
                  {submitting ? t.submitting : (locale === 'zh' || locale === 'zh-Hant' ? '提交申请' : 'Submit request')}
                </button>
              </form>
            </div>
          </div>
        ) : null}

        {showAllPhotos ? (
          <div className={styles.detailOverlay} onClick={() => setShowAllPhotos(false)}>
            <div className={styles.detailPhotoModal} onClick={(e) => e.stopPropagation()}>
              <button type="button" className={styles.detailModalClose} onClick={() => setShowAllPhotos(false)}>×</button>
              <div className={styles.detailPhotoGrid}>
                {gallery.map((url, idx) => (
                  <img key={`${url}-full-${idx}`} className={styles.detailPhotoModalImage} src={url} alt={`${property.hero_title} ${idx + 1}`} />
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}
