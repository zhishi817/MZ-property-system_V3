"use client"

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useMemo, useState } from 'react'
import { resolveAssetUrl } from '../../lib/api'
import type { GuestSiteProperty } from '../../lib/guestSite'
import styles from '../booking.module.css'
import { useSiteCopy } from '../siteContext'

export default function PropertiesClient({ initialProperties }: { initialProperties: GuestSiteProperty[] }) {
  const { t } = useSiteCopy()
  const searchParams = useSearchParams()
  const [properties] = useState<GuestSiteProperty[]>(Array.isArray(initialProperties) ? initialProperties : [])
  const [keyword, setKeyword] = useState(searchParams.get('keyword') || '')
  const [region, setRegion] = useState(searchParams.get('region') || '')
  const [guestCount, setGuestCount] = useState(searchParams.get('guests') || '')
  const [checkin, setCheckin] = useState(searchParams.get('checkin') || '')
  const [checkout, setCheckout] = useState(searchParams.get('checkout') || '')

  const regions = useMemo(
    () => Array.from(new Set(properties.map((item) => item.public_region_label || item.region).filter(Boolean))),
    [properties],
  )

  const filtered = useMemo(() => {
    const key = keyword.trim().toLowerCase()
    const guests = Number(guestCount || 0)
    return properties.filter((item) => {
      const matchKeyword =
        !key ||
        item.hero_title.toLowerCase().includes(key) ||
        item.address.toLowerCase().includes(key) ||
        (item.short_description || '').toLowerCase().includes(key)
      const matchRegion = !region || (item.public_region_label || item.region) === region
      const matchGuests = !guests || Number(item.public_capacity_override || item.capacity || 0) >= guests
      return matchKeyword && matchRegion && matchGuests
    })
  }, [guestCount, keyword, properties, region])

  return (
    <section className={styles.section}>
      <div className={styles.shell}>
        <h1 className={styles.sectionTitle}>{t.propertiesPageTitle}</h1>
        <p className={styles.sectionSubtitle}>{t.propertiesPageSubtitle}</p>
        <div className={styles.filters}>
          <input className={styles.field} placeholder={t.searchKeyword} value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          <select className={styles.field} value={region} onChange={(e) => setRegion(e.target.value)}>
            <option value="">{t.allRegions}</option>
            {regions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <input className={styles.field} type="number" min={1} placeholder={t.guests} value={guestCount} onChange={(e) => setGuestCount(e.target.value)} />
          <input className={styles.field} type="date" value={checkin} onChange={(e) => setCheckin(e.target.value)} />
          <input className={styles.field} type="date" value={checkout} onChange={(e) => setCheckout(e.target.value)} />
        </div>
        {filtered.length ? (
          <div className={styles.propertyGrid}>
            {filtered.map((property) => {
              const href = checkin || checkout ? `/properties/${property.id}?checkin=${encodeURIComponent(checkin)}&checkout=${encodeURIComponent(checkout)}` : `/properties/${property.id}`
              return (
                <Link key={property.id} href={href} className={styles.propertyCard}>
                  {property.hero_image_url ? <img className={styles.propertyImage} src={resolveAssetUrl(property.hero_image_url)} alt={property.hero_title} /> : null}
                  <div className={styles.propertyBody}>
                    <div className={styles.muted}>{property.public_region_label || property.region || 'Melbourne'}</div>
                    <h2 style={{ margin: '8px 0 0', fontSize: 24, letterSpacing: '-0.05em' }}>{property.hero_title}</h2>
                    <p className={styles.sectionSubtitle} style={{ marginBottom: 0, textAlign: 'left', marginLeft: 0 }}>{property.short_description}</p>
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
              )
            })}
          </div>
        ) : (
          <div className={styles.empty}>{t.noMatchedProperties}</div>
        )}
      </div>
    </section>
  )
}
