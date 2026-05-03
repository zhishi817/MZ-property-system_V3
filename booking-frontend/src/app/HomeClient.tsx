"use client"

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { resolveAssetUrl } from '../lib/api'
import type { GuestSiteConfig, GuestSiteProperty } from '../lib/guestSite'
import styles from './booking.module.css'
import { resolveConfiguredText, useSiteCopy } from './siteContext'

const DEFAULT_CONFIG: GuestSiteConfig = {
  banner_title: '安心入住墨尔本',
  banner_subtitle: '精选短租房源，适合商务出行、家庭入住和长期停留。',
  hero_background_urls: [],
  primary_button_text: '查看房源',
  primary_button_href: '/properties',
  secondary_button_text: '联系我们',
  secondary_button_href: '/#contact',
  brand_story: '',
  contact_email: '',
  contact_phone: '',
  contact_whatsapp: '',
  contact_address: '',
  faq_items: [],
}

const WEEKDAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

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

function formatDateDisplay(value: string, locale: string, emptyLabel: string) {
  const date = parseIsoDate(value)
  if (!date) return emptyLabel
  if (locale === 'zh' || locale === 'zh-Hant') {
    return `${date.getFullYear()} / ${String(date.getMonth() + 1).padStart(2, '0')} / ${String(date.getDate()).padStart(2, '0')}`
  }
  return new Intl.DateTimeFormat('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }).format(date)
}

function formatMonthTitle(date: Date, locale: string) {
  if (locale === 'zh' || locale === 'zh-Hant') return `${date.getFullYear()}年 ${date.getMonth() + 1}月`
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(date)
}

export default function HomeClient({
  initialConfig,
  initialProperties,
}: {
  initialConfig: GuestSiteConfig | null
  initialProperties: GuestSiteProperty[]
}) {
  const { locale, t } = useSiteCopy()
  const searchAreaRef = useRef<HTMLDivElement | null>(null)
  const [config] = useState<GuestSiteConfig>(initialConfig || DEFAULT_CONFIG)
  const [properties] = useState<GuestSiteProperty[]>(Array.isArray(initialProperties) ? initialProperties : [])
  const [loading] = useState(false)
  const [activeRegion, setActiveRegion] = useState('')
  const [activeHeroIndex, setActiveHeroIndex] = useState(0)
  const [activePopover, setActivePopover] = useState<'location' | 'dates' | 'guests' | null>(null)
  const [datePickerOpen, setDatePickerOpen] = useState(false)
  const [activeDateField, setActiveDateField] = useState<'checkin' | 'checkout'>('checkin')
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(new Date()))
  const [guestCounts, setGuestCounts] = useState({
    adults: 0,
    children: 0,
    infants: 0,
    pets: 0,
  })
  const [search, setSearch] = useState({
    location: '',
    checkin: '',
    checkout: '',
    guests: '',
  })

  const heroImages = useMemo(() => {
    const configured = Array.isArray(config.hero_background_urls) ? config.hero_background_urls.map((item) => resolveAssetUrl(item)).filter(Boolean) : []
    if (configured.length) return configured
    const fallback = resolveAssetUrl(properties.find((item) => item.hero_image_url)?.hero_image_url || '')
    return fallback ? [fallback] : []
  }, [config.hero_background_urls, properties])
  const heroImage = heroImages[activeHeroIndex] || ''
  const aboutImage = useMemo(
    () =>
      resolveAssetUrl(properties.find((item) => item.gallery_urls?.[1])?.gallery_urls?.[1] || properties.find((item) => item.hero_image_url)?.hero_image_url || ''),
    [properties],
  )
  const regions = useMemo(() => Array.from(new Set(properties.map((item) => item.public_region_label || item.region).filter(Boolean))), [properties])
  const featuredProperties = useMemo(
    () => (!activeRegion ? properties : properties.filter((item) => (item.public_region_label || item.region) === activeRegion)).slice(0, 3),
    [activeRegion, properties],
  )
  const mapUrl = useMemo(() => {
    const target = String(config.contact_address || '').trim()
    return target ? `https://www.google.com/maps?q=${encodeURIComponent(target)}&output=embed` : ''
  }, [config.contact_address])
  const weekdays = locale === 'zh' || locale === 'zh-Hant' ? WEEKDAYS_ZH : WEEKDAYS_EN
  const checkinDate = parseIsoDate(search.checkin)
  const checkoutDate = parseIsoDate(search.checkout)
  const totalGuests = guestCounts.adults + guestCounts.children + guestCounts.infants
  const guestSummary = totalGuests ? `${totalGuests} ${t.guestsUnit}` : t.addGuests

  useEffect(() => {
    setSearch((prev) => {
      const nextGuests = totalGuests ? String(totalGuests) : ''
      return prev.guests === nextGuests ? prev : { ...prev, guests: nextGuests }
    })
  }, [totalGuests])

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!searchAreaRef.current?.contains(event.target as Node)) {
        setActivePopover(null)
        setDatePickerOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [])

  useEffect(() => {
    setActiveHeroIndex(0)
  }, [heroImages.length])

  useEffect(() => {
    if (heroImages.length <= 1) return
    const timer = window.setInterval(() => {
      setActiveHeroIndex((prev) => (prev + 1) % heroImages.length)
    }, 4500)
    return () => window.clearInterval(timer)
  }, [heroImages])

  function buildSearchHref() {
    const params = new URLSearchParams()
    if (search.location) params.set('region', search.location)
    if (search.checkin) params.set('checkin', search.checkin)
    if (search.checkout) params.set('checkout', search.checkout)
    if (search.guests) params.set('guests', search.guests)
    const qs = params.toString()
    return qs ? `/properties?${qs}` : '/properties'
  }

  function openDatePicker(field: 'checkin' | 'checkout') {
    setActiveDateField(field)
    const seed = field === 'checkout' ? checkoutDate || checkinDate || new Date() : checkinDate || new Date()
    setVisibleMonth(startOfMonth(seed || new Date()))
    setDatePickerOpen(true)
    setActivePopover('dates')
  }

  function clearDates() {
    setSearch((prev) => ({ ...prev, checkin: '', checkout: '' }))
    setActiveDateField('checkin')
  }

  function handleDatePick(date: Date) {
    const picked = toIsoDate(date)
    setSearch((prev) => {
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

    if (activeDateField === 'checkin') {
      setActiveDateField('checkout')
    } else {
      setDatePickerOpen(false)
      setActivePopover(null)
      setActiveDateField('checkin')
    }
  }

  function toggleLocationPopover() {
    setDatePickerOpen(false)
    setActivePopover((prev) => (prev === 'location' ? null : 'location'))
  }

  function toggleGuestsPopover() {
    setDatePickerOpen(false)
    setActivePopover((prev) => (prev === 'guests' ? null : 'guests'))
  }

  function updateGuestCount(key: keyof typeof guestCounts, delta: number) {
    setGuestCounts((prev) => ({
      ...prev,
      [key]: Math.max(0, prev[key] + delta),
    }))
  }

  function isInRange(date: Date) {
    if (!checkinDate || !checkoutDate) return false
    return date > checkinDate && date < checkoutDate
  }

  const monthCards = [visibleMonth, addMonths(visibleMonth, 1)]

  const heroTitle = resolveConfiguredText(config.banner_title, t.heroTitle, 'Stay in Melbourne with confidence', locale)
  const heroSubtitle = resolveConfiguredText(config.banner_subtitle, t.heroSubtitle, 'Curated short stay homes for business trips, family stays, and longer visits.', locale)
  const primaryButtonText = resolveConfiguredText(config.primary_button_text, t.browseProperties, 'Browse Properties', locale)
  const secondaryButtonText = resolveConfiguredText(config.secondary_button_text, t.contactUs, 'Contact Us', locale)
  const brandStory = config.brand_story ? config.brand_story : t.aboutFallback

  return (
    <>
      <section className={styles.hero}>
        <div className={styles.heroGrid}>
          {heroImages.map((image, index) => (
            <img
              key={`${image}-${index}`}
              className={`${styles.heroBackdrop} ${index === activeHeroIndex ? styles.heroBackdropActive : ''}`}
              src={image}
              alt="Featured stay"
            />
          ))}
          <div className={styles.heroOverlay} />
          <div className={styles.shell}>
            <div className={styles.heroInner}>
              <div className={styles.heroCopy}>
                <span className={styles.eyebrow}>{t.heroEyebrow}</span>
                <h1 className={styles.heroTitle}>{heroTitle}</h1>
                <p className={styles.heroSubtitle}>{heroSubtitle}</p>
                <div className={styles.heroActions}>
                  <Link href={config.primary_button_href || '/properties'} className={`${styles.cta} ${styles.ctaPrimary}`}>
                    {primaryButtonText}
                  </Link>
                  <Link href={config.secondary_button_href || '/#contact'} className={`${styles.cta} ${styles.ctaSecondary}`}>
                    {secondaryButtonText}
                  </Link>
                </div>
              </div>
            </div>
          </div>
          {heroImages.length > 1 ? (
            <div className={styles.heroDots}>
              {heroImages.map((image, index) => (
                <button
                  key={`${image}-dot-${index}`}
                  type="button"
                  className={`${styles.heroDot} ${index === activeHeroIndex ? styles.heroDotActive : ''}`}
                  onClick={() => setActiveHeroIndex(index)}
                  aria-label={`hero slide ${index + 1}`}
                />
              ))}
            </div>
          ) : null}
        </div>
        <div className={`${styles.shell} ${styles.searchWrap}`} ref={searchAreaRef}>
          <div className={styles.searchBar}>
            <button type="button" className={`${styles.searchCell} ${styles.searchCellButton}`} onClick={toggleLocationPopover}>
              <span className={styles.searchTitle}>{t.location}</span>
              <span className={`${styles.searchValueText} ${styles.searchValueTextActive}`}>{search.location || t.allCities}</span>
            </button>
            <button type="button" className={`${styles.searchCell} ${styles.searchCellButton}`} onClick={() => openDatePicker('checkin')}>
              <span className={styles.searchTitle}>{t.checkin}</span>
              <span className={`${styles.searchValueText} ${search.checkin ? styles.searchValueTextActive : ''}`}>
                {formatDateDisplay(search.checkin, locale, t.addDates)}
              </span>
            </button>
            <button type="button" className={`${styles.searchCell} ${styles.searchCellButton}`} onClick={() => openDatePicker('checkout')}>
              <span className={styles.searchTitle}>{t.checkout}</span>
              <span className={`${styles.searchValueText} ${search.checkout ? styles.searchValueTextActive : ''}`}>
                {formatDateDisplay(search.checkout, locale, t.addDates)}
              </span>
            </button>
            <button type="button" className={`${styles.searchCell} ${styles.searchCellButton}`} onClick={toggleGuestsPopover}>
              <span className={styles.searchTitle}>{t.guests}</span>
              <span className={`${styles.searchValueText} ${totalGuests ? styles.searchValueTextActive : ''}`}>{guestSummary}</span>
            </button>
            <Link href={buildSearchHref()} className={styles.searchButton} aria-label={t.search}>
              <svg viewBox="0 0 24 24" className={styles.searchButtonIcon} aria-hidden="true">
                <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M16 16L21 21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </Link>
          </div>

          {activePopover === 'location' ? (
            <div className={`${styles.searchPopover} ${styles.locationPopover}`}>
              <button
                type="button"
                className={`${styles.locationOption} ${search.location === '' ? styles.locationOptionActive : ''}`}
                onClick={() => {
                  setSearch((prev) => ({ ...prev, location: '' }))
                  setActivePopover(null)
                }}
              >
                {t.allCities}
              </button>
              {regions.map((region) => (
                <button
                  key={region}
                  type="button"
                  className={`${styles.locationOption} ${search.location === region ? styles.locationOptionActive : ''}`}
                  onClick={() => {
                    setSearch((prev) => ({ ...prev, location: region }))
                    setActivePopover(null)
                  }}
                >
                  {region}
                </button>
              ))}
            </div>
          ) : null}

          {datePickerOpen && activePopover === 'dates' ? (
            <div className={styles.datePopover}>
              <div className={styles.datePopoverHeader}>
                <button type="button" className={styles.calendarArrow} onClick={() => setVisibleMonth((prev) => addMonths(prev, -1))}>
                  ‹
                </button>
                <div className={styles.datePopoverHint}>
                  {activeDateField === 'checkin' ? t.checkin : t.checkout}
                </div>
                <button type="button" className={styles.calendarArrow} onClick={() => setVisibleMonth((prev) => addMonths(prev, 1))}>
                  ›
                </button>
              </div>
              <div className={styles.calendarMonths}>
                {monthCards.map((month) => {
                  const days = buildMonthDays(month)
                  return (
                    <div key={`${month.getFullYear()}-${month.getMonth()}`} className={styles.calendarMonth}>
                      <div className={styles.calendarMonthTitle}>{formatMonthTitle(month, locale)}</div>
                      <div className={styles.calendarWeekdays}>
                        {weekdays.map((label) => (
                          <span key={`${month.getMonth()}-${label}`}>{label}</span>
                        ))}
                      </div>
                      <div className={styles.calendarDays}>
                        {days.map((day) => {
                          const outside = day.getMonth() !== month.getMonth()
                          const isCheckin = sameDay(day, checkinDate)
                          const isCheckout = sameDay(day, checkoutDate)
                          const inRange = isInRange(day)
                          return (
                            <button
                              key={toIsoDate(day)}
                              type="button"
                              className={[
                                styles.calendarDay,
                                outside ? styles.calendarDayMuted : '',
                                isCheckin || isCheckout ? styles.calendarDaySelected : '',
                                inRange ? styles.calendarDayInRange : '',
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
              <div className={styles.datePopoverFooter}>
                <button type="button" className={styles.clearDatesButton} onClick={clearDates}>
                  {t.clearDates}
                </button>
              </div>
            </div>
          ) : null}

          {activePopover === 'guests' ? (
            <div className={`${styles.searchPopover} ${styles.guestsPopover}`}>
              {[
                { key: 'adults', label: t.adults, hint: t.adultsHint },
                { key: 'children', label: t.children, hint: t.childrenHint },
                { key: 'infants', label: t.infants, hint: t.infantsHint },
                { key: 'pets', label: t.pets, hint: t.petsHint },
              ].map((item) => {
                const value = guestCounts[item.key as keyof typeof guestCounts]
                return (
                  <div key={item.key} className={styles.guestRow}>
                    <div className={styles.guestInfo}>
                      <div className={styles.guestLabel}>{item.label}</div>
                      {item.hint ? <div className={styles.guestHint}>{item.hint}</div> : null}
                    </div>
                    <div className={styles.guestControls}>
                      <button type="button" className={styles.guestStepper} onClick={() => updateGuestCount(item.key as keyof typeof guestCounts, -1)} disabled={value === 0}>
                        −
                      </button>
                      <span className={styles.guestCount}>{value}</span>
                      <button type="button" className={styles.guestStepper} onClick={() => updateGuestCount(item.key as keyof typeof guestCounts, 1)}>
                        +
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : null}
        </div>
      </section>

      <section className={styles.section} id="properties">
        <div className={styles.shell}>
          <h2 className={styles.sectionTitle}>{t.listingsTitle}</h2>
          <p className={styles.sectionSubtitle}>{t.listingsSubtitle}</p>
          <div className={styles.tabRow}>
            <button className={`${styles.tabButton} ${activeRegion === '' ? styles.tabButtonActive : ''}`} onClick={() => setActiveRegion('')} type="button">
              {t.all}
            </button>
            {regions.map((region) => (
              <button
                key={region}
                className={`${styles.tabButton} ${activeRegion === region ? styles.tabButtonActive : ''}`}
                onClick={() => setActiveRegion(region)}
                type="button"
              >
                {region}
              </button>
            ))}
          </div>
          {loading ? (
            <div className={styles.empty}>{t.loadingProperties}</div>
          ) : featuredProperties.length ? (
            <div className={styles.propertyGrid}>
              {featuredProperties.map((property) => (
                <Link key={property.id} href={`/properties/${property.id}`} className={styles.propertyCard}>
                  {property.hero_image_url ? <img className={styles.propertyImage} src={resolveAssetUrl(property.hero_image_url)} alt={property.hero_title} /> : null}
                  <div className={`${styles.propertyBody} ${styles.propertyBodyCompact}`}>
                    <h3 style={{ margin: 0, fontSize: 24, letterSpacing: '-0.04em' }}>{property.hero_title}</h3>
                    <div className={styles.muted} style={{ marginTop: 6 }}>{property.public_region_label || property.region || 'Melbourne'}</div>
                    <div className={styles.propertySpecs}>
                      {property.public_capacity_override || property.capacity} {t.guestsUnit}
                      {property.bed_config ? ` · ${property.bed_config}` : ''}
                      {property.type ? ` · ${property.type}` : ''}
                    </div>
                    <div className={styles.propertyFoot}>
                      <span className={styles.propertyPriceHint}>{t.inquiryOnly}</span>
                      <span className={styles.muted}>{t.viewDetails}</span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className={styles.empty}>{t.noListings}</div>
          )}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.shell}>
          <span className={styles.sectionEyebrow}>{t.location}</span>
          <h2 className={styles.sectionTitle}>{t.locationTitle}</h2>
          <p className={styles.sectionSubtitle}>{t.locationSubtitle}</p>
          <div className={`${styles.panel} ${styles.locationPanel}`}>
            {mapUrl ? <iframe className={styles.mapFrame} src={mapUrl} loading="lazy" referrerPolicy="no-referrer-when-downgrade" title="MZ Property location" /> : <div className={styles.mapFrame} />}
            <div className={styles.locationBody}>
              <strong>{config.contact_address || t.addressPending}</strong>
              <div className={styles.muted} style={{ marginTop: 8 }}>
                {config.contact_phone || config.contact_email || t.contactPending}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={`${styles.section} ${styles.aboutSection}`} id="about">
        <div className={styles.shell}>
          <div className={styles.aboutGrid}>
            <div>
              <h2 className={styles.sectionTitle} style={{ textAlign: 'left' }}>{t.aboutTitle}</h2>
              <p className={styles.sectionSubtitle} style={{ textAlign: 'left', marginLeft: 0 }}>
                {brandStory}
              </p>
              <div className={styles.faqList} id="faq">
                {(config.faq_items || []).map((item, idx) => (
                  <div key={`${item.question}-${idx}`} className={styles.faqItem}>
                    <strong>{item.question}</strong>
                    <div className={styles.muted} style={{ marginTop: 8 }}>{item.answer}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className={styles.aboutMedia}>
              {aboutImage ? <img src={aboutImage} alt="About MZ Property" /> : null}
            </div>
          </div>
        </div>
      </section>

      <section className={styles.section} id="listing">
        <div className={styles.shell}>
          <div className={styles.panel}>
            <h2 className={styles.detailSectionTitle}>{t.navListing}</h2>
            <p className={styles.muted}>
              {locale === 'zh'
                ? '如果你有房源希望交给 MZ Property 运营与短租管理，欢迎通过下方联系方式与我们沟通。'
                : 'If you would like MZ Property to manage and list your property, contact us through the details below.'}
            </p>
          </div>
        </div>
      </section>

      <section className={styles.section} id="contact">
        <div className={styles.shell}>
          <div className={styles.contactGrid}>
            <div className={styles.panel}>
              <strong>{t.email}</strong>
              <div className={styles.muted}>{config.contact_email || t.notSetYet}</div>
            </div>
            <div className={styles.panel}>
              <strong>{t.phoneWhatsApp}</strong>
              <div className={styles.muted}>{config.contact_phone || config.contact_whatsapp || t.notSetYet}</div>
            </div>
          </div>
        </div>
      </section>
    </>
  )
}
