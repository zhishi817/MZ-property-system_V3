"use client"

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { resolveAssetUrl } from '../../lib/api'
import { addIsoCalendarDays, melbourneTodayISO } from '../../lib/homepage'
import {
  DEFAULT_PROPERTY_LISTING_FILTERS,
  propertyDetailHref,
  propertyListingAreaLabel,
  propertyListingDateErrors,
  propertyListingFiltersFromSearchParams,
  propertyListingFiltersToSearchParams,
  propertyListingSummary,
  propertyMatchesListingFilters,
  sanitizeGuestSiteProperties,
  type BedroomFilter,
  type PropertyListingFeed,
  type PropertyListingFilters,
  type PropertyTypeFilter,
} from '../../lib/propertyListing'
import type { GuestSiteProperty } from '../../lib/guestSite'
import HomeHeader from '../home/HomeHeader'
import SiteFooter from '../home/SiteFooter'
import EnglishSelect, { type EnglishSelectOption } from '../home/EnglishSelect'
import PropertyDateField from './PropertyDateField'
import styles from './properties.module.css'

type FooterContent = {
  contactEmail: string
  contactPhone: string
  contactWhatsapp: string
  contactAddress: string
}

type FilterErrors = Partial<Record<'checkin' | 'checkout', string>>
type FeedStatus = PropertyListingFeed['status'] | 'loading'

const BEDROOM_OPTIONS: Array<{ value: BedroomFilter; label: string }> = [
  { value: 'any', label: 'Any' },
  { value: 'studio', label: 'Studio' },
  { value: '1', label: '1 bed' },
  { value: '2', label: '2 bed' },
  { value: '3', label: '3 bed' },
]

const TYPE_OPTIONS: Array<{ value: PropertyTypeFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'apartment', label: 'Apartment' },
  { value: 'house', label: 'House' },
]

const GUEST_OPTIONS: readonly EnglishSelectOption[] = [
  { value: '', label: 'Any guests' },
  ...Array.from({ length: 8 }, (_, index) => {
    const count = index + 1
    return { value: String(count), label: `${count} ${count === 1 ? 'guest' : 'guests'}` }
  }),
]

function containsHan(value: string) {
  return /[\u3400-\u9fff]/.test(value)
}

function publicText(value: string, fallback: string) {
  const normalized = String(value || '').trim()
  return normalized && !containsHan(normalized) ? normalized : fallback
}

function publicTypeLabel(property: GuestSiteProperty) {
  const type = String(property.type || '').trim()
  if (!type) return ''
  if (!containsHan(type)) return type
  if (['一房一卫', '两房一卫'].includes(type)) return 'Apartment'
  return ''
}

function bedroomLabel(count: number | undefined) {
  if (count == null) return ''
  if (count === 0) return 'Studio'
  return `${count} ${count === 1 ? 'bedroom' : 'bedrooms'}`
}

function selectedFilterDescription(filters: PropertyListingFilters) {
  const bedroom = BEDROOM_OPTIONS.find((option) => option.value === filters.bedrooms)?.label || 'Any'
  const type = TYPE_OPTIONS.find((option) => option.value === filters.type)?.label || 'All'
  return `${bedroom === 'Any' ? 'All bedrooms' : bedroom} · ${type === 'All' ? 'All property types' : type}`
}

function ListingFilterControls({
  idPrefix,
  filters,
  areas,
  errors,
  showSubmit = false,
  onChange,
}: {
  idPrefix: string
  filters: PropertyListingFilters
  areas: string[]
  errors: FilterErrors
  showSubmit?: boolean
  onChange: (next: PropertyListingFilters) => void
}) {
  const today = melbourneTodayISO()
  const [openSelect, setOpenSelect] = useState<'area' | 'guests' | null>(null)
  const areaRef = useRef<HTMLButtonElement>(null)
  const guestsRef = useRef<HTMLButtonElement>(null)
  const areaOptions = useMemo(() => {
    const options = areas.map((area) => ({ value: area, label: area }))
    if (filters.area !== 'all-melbourne' && !options.some((option) => option.value === filters.area)) {
      options.unshift({ value: filters.area, label: propertyListingAreaLabel(filters.area) })
    }
    return options
  }, [areas, filters.area])

  return (
    <>
      <div className={styles.searchFields}>
        <EnglishSelect
          id={`${idPrefix}-area`}
          label="Area"
          value={filters.area}
          options={[{ value: 'all-melbourne', label: 'All Melbourne' }, ...areaOptions]}
          open={openSelect === 'area'}
          className={styles.selectField}
          triggerRef={areaRef}
          onOpenChange={(open) => setOpenSelect(open ? 'area' : null)}
          onChange={(area) => onChange({ ...filters, area })}
        />
        <PropertyDateField
          id={`${idPrefix}-checkin`}
          label="Check-in"
          value={filters.checkin}
          min={today}
          today={today}
          error={errors.checkin}
          onChange={(checkin) => onChange({
            ...filters,
            checkin,
            checkout: checkin && filters.checkout && filters.checkout <= checkin ? '' : filters.checkout,
          })}
        />
        <PropertyDateField
          id={`${idPrefix}-checkout`}
          label="Check-out"
          value={filters.checkout}
          min={filters.checkin ? addIsoCalendarDays(filters.checkin, 1) : today}
          today={today}
          error={errors.checkout}
          onChange={(checkout) => onChange({ ...filters, checkout })}
        />
        <EnglishSelect
          id={`${idPrefix}-guests`}
          label="Guests"
          value={filters.guests}
          options={GUEST_OPTIONS}
          open={openSelect === 'guests'}
          align="right"
          className={styles.selectField}
          hint="Capacity meets or exceeds your group"
          hintClassName={styles.fieldHint}
          triggerRef={guestsRef}
          onOpenChange={(open) => setOpenSelect(open ? 'guests' : null)}
          onChange={(guests) => onChange({ ...filters, guests })}
        />
        {showSubmit ? <button className={styles.showButton} type="submit">Show stays <img src="/homepage/icon-arrow-right.svg" alt="" /></button> : null}
      </div>

      <div className={styles.filterGroups}>
        <fieldset>
          <legend>Bedrooms</legend>
          <div className={styles.choiceRow}>
            {BEDROOM_OPTIONS.map((option) => (
              <button
                className={`${styles.choice} ${filters.bedrooms === option.value ? styles.choiceActive : ''}`}
                type="button"
                aria-pressed={filters.bedrooms === option.value}
                onClick={() => onChange({ ...filters, bedrooms: option.value })}
                key={option.value}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Property type</legend>
          <div className={styles.choiceRow}>
            {TYPE_OPTIONS.map((option) => (
              <button
                className={`${styles.choice} ${filters.type === option.value ? styles.choiceActive : ''}`}
                type="button"
                aria-pressed={filters.type === option.value}
                onClick={() => onChange({ ...filters, type: option.value })}
                key={option.value}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>
      </div>
    </>
  )
}

function PropertyCard({ property, filters }: { property: GuestSiteProperty; filters: PropertyListingFilters }) {
  const title = publicText(property.hero_title, 'Published Melbourne stay')
  const region = publicText(property.public_region_label, 'Melbourne')
  const capacity = Math.max(0, Number(property.public_capacity_override ?? property.capacity) || 0)
  const type = publicTypeLabel(property)
  const bedroom = bedroomLabel(property.bedroom_count)
  const image = resolveAssetUrl(property.hero_image_url)
  const specs = [
    capacity ? `${capacity} ${capacity === 1 ? 'guest' : 'guests'}` : '',
    bedroom,
    type,
  ].filter(Boolean)

  return (
    <article className={styles.propertyCard}>
      <Link className={styles.cardLink} href={propertyDetailHref(property.id, filters)} aria-label={`View ${title}`}>
        <div className={styles.propertyMedia}>
          {image
            ? <img src={image} alt={`${title} published property image`} />
            : <div className={styles.photoPending}><span>Photography coming soon</span></div>}
          <span className={styles.publishedBadge}>Published listing</span>
        </div>
        <div className={styles.propertyCopy}>
          <p className={styles.propertyRegion}>{region}</p>
          <h3>{title}</h3>
          <div className={styles.specs} aria-label="Property summary">
            {specs.map((spec) => <span key={spec}>{spec}</span>)}
          </div>
          <div className={styles.cardFooter}>
            <b>View details <img src="/homepage/icon-arrow-right.svg" alt="" /></b>
          </div>
        </div>
      </Link>
    </article>
  )
}

export default function PropertiesClient({
  initialProperties,
  initialStatus,
  footerContent,
}: {
  initialProperties: GuestSiteProperty[]
  initialStatus: PropertyListingFeed['status']
  footerContent: FooterContent
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const searchKey = searchParams.toString()
  const appliedFilters = useMemo(
    () => propertyListingFiltersFromSearchParams(new URLSearchParams(searchKey)),
    [searchKey],
  )
  const [properties, setProperties] = useState(() => sanitizeGuestSiteProperties(initialProperties))
  const [feedStatus, setFeedStatus] = useState<FeedStatus>(initialStatus)
  const [feedMessage, setFeedMessage] = useState(initialStatus === 'error' ? 'Published properties could not be loaded right now.' : '')
  const [desktopDraft, setDesktopDraft] = useState(appliedFilters)
  const [mobileDraft, setMobileDraft] = useState(appliedFilters)
  const [desktopErrors, setDesktopErrors] = useState<FilterErrors>({})
  const [mobileErrors, setMobileErrors] = useState<FilterErrors>({})
  const [drawerOpen, setDrawerOpen] = useState(false)
  const filterTriggerRef = useRef<HTMLButtonElement | null>(null)
  const drawerRef = useRef<HTMLElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const pendingSearchKeyRef = useRef<string | null>(null)

  const areas = useMemo(
    () => Array.from(new Set(properties
      .map((property) => publicText(property.public_region_label, ''))
      .filter(Boolean)))
      .sort((left, right) => left.localeCompare(right, 'en-AU')),
    [properties],
  )

  const filteredProperties = useMemo(
    () => properties.filter((property) => propertyMatchesListingFilters(property, appliedFilters)),
    [appliedFilters, properties],
  )
  const mobileResultCount = useMemo(
    () => properties.filter((property) => propertyMatchesListingFilters(property, mobileDraft)).length,
    [mobileDraft, properties],
  )

  useEffect(() => {
    if (pendingSearchKeyRef.current === searchKey) {
      pendingSearchKeyRef.current = null
      return
    }
    setDesktopDraft(appliedFilters)
    setDesktopErrors({})
    setMobileDraft(appliedFilters)
    setMobileErrors({})
  }, [appliedFilters, searchKey])

  const cancelDrawer = useCallback(() => {
    setDrawerOpen(false)
    setMobileDraft(appliedFilters)
    setMobileErrors({})
    window.requestAnimationFrame(() => filterTriggerRef.current?.focus())
  }, [appliedFilters])

  useEffect(() => {
    if (!drawerOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.target instanceof Element && event.target.closest('[role="listbox"], [aria-haspopup="listbox"][aria-expanded="true"]')) return
        event.preventDefault()
        cancelDrawer()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...(drawerRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])') || [])]
      if (focusable.length < 2) return
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
  }, [cancelDrawer, drawerOpen])

  function navigateWithFilters(filters: PropertyListingFilters) {
    const params = propertyListingFiltersToSearchParams(filters)
    const query = params.toString()
    pendingSearchKeyRef.current = query
    setDesktopDraft(filters)
    setMobileDraft(filters)
    router.push(query ? `/properties?${query}` : '/properties', { scroll: false })
  }

  function validateAndApply(filters: PropertyListingFilters, scope: 'desktop' | 'mobile') {
    const errors = propertyListingDateErrors(filters, melbourneTodayISO())
    if (scope === 'desktop') setDesktopErrors(errors)
    else setMobileErrors(errors)
    const firstError = errors.checkin ? 'checkin' : errors.checkout ? 'checkout' : ''
    if (firstError) {
      window.requestAnimationFrame(() => document.getElementById(`${scope}-${firstError}`)?.focus())
      return false
    }
    navigateWithFilters(filters)
    window.requestAnimationFrame(() => document.getElementById('property-results')?.focus({ preventScroll: true }))
    return true
  }

  function submitDesktop(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    validateAndApply(desktopDraft, 'desktop')
  }

  function clearAppliedFilters() {
    setDesktopDraft(DEFAULT_PROPERTY_LISTING_FILTERS)
    setDesktopErrors({})
    navigateWithFilters(DEFAULT_PROPERTY_LISTING_FILTERS)
  }

  function openDrawer() {
    setMobileDraft(appliedFilters)
    setMobileErrors({})
    setDrawerOpen(true)
  }

  function applyDrawer() {
    if (!validateAndApply(mobileDraft, 'mobile')) return
    setDrawerOpen(false)
    window.requestAnimationFrame(() => filterTriggerRef.current?.focus())
  }

  async function retryProperties() {
    if (feedStatus === 'loading') return
    setFeedStatus('loading')
    setFeedMessage('')
    try {
      const response = await fetch('/api/properties?refresh=1', { method: 'GET', cache: 'no-store' })
      const payload = await response.json().catch(() => null) as { properties?: unknown } | null
      if (!response.ok || !payload) throw new Error('property_feed_failed')
      const nextProperties = sanitizeGuestSiteProperties(payload.properties)
      setProperties(nextProperties)
      setFeedStatus(nextProperties.length ? 'ready' : 'empty')
    } catch {
      setFeedStatus('error')
      setFeedMessage('Published properties could not be loaded right now.')
    }
  }

  return (
    <div className={styles.page} data-properties-page data-feed-status={feedStatus}>
      <a className={styles.skipLink} href="#property-results">Skip to property results</a>
      <HomeHeader />
      <main id="main-content">
        <section className={styles.intro} aria-labelledby="properties-page-title">
          <div className={styles.introCopy}>
            <p className={styles.eyebrow}>Stay Melbourne, live local</p>
            <h1 id="properties-page-title">Find a property<br />that feels like yours.</h1>
          </div>
          <div className={styles.introNote}>
            <p>Explore the full MZ Property collection through one clear, considered search experience.</p>
            <p className={styles.availabilityNotice}><strong>Plan first, confirm later.</strong> Dates are carried into property details, but live Hostex availability and pricing are not connected.</p>
          </div>
        </section>

        <section className={styles.searchSection} aria-labelledby="search-title">
          <div className={styles.mobileSearchSummary}>
            <button ref={filterTriggerRef} className={styles.summaryButton} type="button" aria-haspopup="dialog" aria-expanded={drawerOpen} onClick={openDrawer}>
              <span><small>Your search</small><strong>{propertyListingSummary(appliedFilters)}</strong></span>
              <b>Filters</b>
            </button>
          </div>

          <form className={styles.filterShell} onSubmit={submitDesktop} data-desktop-filters>
            <div className={styles.filterHeading}>
              <div><p className={styles.eyebrow}>Search the collection</p><h2 id="search-title">Shape your stay.</h2></div>
              <button className={styles.clearButton} type="button" onClick={clearAppliedFilters}>Clear all</button>
            </div>
            <ListingFilterControls idPrefix="desktop" filters={desktopDraft} areas={areas} errors={desktopErrors} showSubmit onChange={setDesktopDraft} />
            <div className={styles.desktopActions}>
              <div className={styles.honestyNote} role="note">
                <strong>Availability comes later.</strong>
                <span>Dates are retained for the detail page only. They do not filter this list by live availability and no live price is shown.</span>
              </div>
            </div>
          </form>
        </section>

        <section className={styles.results} id="property-results" tabIndex={-1} aria-labelledby="results-title" aria-busy={feedStatus === 'loading'}>
          <div className={styles.resultsHeading}>
            <div><p className={styles.eyebrow}>All publicly listed stays</p><h2 id="results-title">Melbourne properties.</h2></div>
            <div className={styles.resultsMeta} aria-live="polite">
              <strong>{filteredProperties.length} {filteredProperties.length === 1 ? 'property' : 'properties'}</strong>
              <span>{selectedFilterDescription(appliedFilters)}</span>
            </div>
          </div>

          {feedStatus === 'loading' ? (
            <div className={styles.statusPanel} role="status"><strong>Loading published properties…</strong><span>Your filters are preserved while the list reloads.</span></div>
          ) : null}
          {feedStatus === 'error' ? (
            <div className={styles.statusPanel} role="alert">
              <strong>We could not load the property collection.</strong>
              <span>{feedMessage}</span>
              <button className={styles.outlineButton} type="button" onClick={retryProperties}>Retry</button>
            </div>
          ) : null}
          {feedStatus === 'empty' ? (
            <div className={styles.statusPanel} role="status">
              <strong>No properties are published yet.</strong>
              <span>Only published, non-archived listings appear here.</span>
            </div>
          ) : null}
          {feedStatus === 'ready' && !filteredProperties.length ? (
            <div className={styles.statusPanel} role="status">
              <strong>No properties match these filters.</strong>
              <span>Try a different area, group size, bedroom count or property type.</span>
              <button className={styles.outlineButton} type="button" onClick={clearAppliedFilters}>Clear filters</button>
            </div>
          ) : null}
          {feedStatus === 'ready' && filteredProperties.length ? (
            <div className={styles.propertyGrid}>
              {filteredProperties.map((property) => <PropertyCard property={property} filters={appliedFilters} key={property.id} />)}
            </div>
          ) : null}
        </section>

        <section className={styles.closing} aria-labelledby="closing-title">
          <div><p className={styles.eyebrow}>A clearer path to the right stay</p><h2 id="closing-title">Browse first.<br />Confirm live details later.</h2></div>
          <p>This collection supports useful discovery now. Live availability and pricing remain reserved for the approved Hostex integration phase; until then, property details stay factual and enquiry-led.</p>
        </section>
      </main>
      <SiteFooter content={footerContent} footerLabel="Published property collection" />

      {drawerOpen ? (
        <div className={styles.filterOverlay} onMouseDown={(event) => { if (event.target === event.currentTarget) cancelDrawer() }}>
          <section ref={drawerRef} className={styles.filterDrawer} role="dialog" aria-modal="true" aria-labelledby="mobile-filters-title">
            <div className={styles.drawerHeading}>
              <div><p className={styles.eyebrow}>Refine your stay</p><h2 id="mobile-filters-title">Filters</h2></div>
              <button ref={closeButtonRef} className={styles.closeButton} type="button" aria-label="Cancel filters" onClick={cancelDrawer}>
                <img src="/homepage/icon-close.svg" alt="" />
              </button>
            </div>
            <div className={styles.drawerContent}>
              <ListingFilterControls idPrefix="mobile" filters={mobileDraft} areas={areas} errors={mobileErrors} onChange={setMobileDraft} />
              <div className={styles.honestyNote} role="note"><strong>No live availability check.</strong><span>Dates are saved with your search and passed to details only.</span></div>
            </div>
            <div className={styles.drawerActions}>
              <button className={styles.clearButton} type="button" onClick={() => { setMobileDraft(DEFAULT_PROPERTY_LISTING_FILTERS); setMobileErrors({}) }}>Clear all</button>
              <button className={styles.showButton} type="button" onClick={applyDrawer}>Show {mobileResultCount} {mobileResultCount === 1 ? 'stay' : 'stays'}</button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}
