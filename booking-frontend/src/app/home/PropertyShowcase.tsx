"use client"

import Link from 'next/link'
import { useState } from 'react'
import { resolveAssetUrl } from '../../lib/api'
import type { HomepageProperty, HomepagePropertyFeed } from '../../lib/homepage'
import s from './home.module.css'

const placeholderImages = [
  '/homepage/property-st-kilda.jpeg',
  '/homepage/property-docklands.avif',
  '/homepage/property-melbourne-web.jpeg',
]

function propertyMeta(property: HomepageProperty) {
  const parts = []
  if (property.bedrooms != null) parts.push(`${property.bedrooms} ${property.bedrooms === 1 ? 'Bedroom' : 'Bedrooms'}`)
  if (property.bathrooms != null) parts.push(`${property.bathrooms} ${property.bathrooms === 1 ? 'Bathroom' : 'Bathrooms'}`)
  return parts.join(' · ') || 'Published details available on the property page'
}

export default function PropertyShowcase({ initialFeed }: { initialFeed: HomepagePropertyFeed }) {
  const [feed, setFeed] = useState(initialFeed)
  const [loading, setLoading] = useState(false)

  async function retry() {
    if (loading) return
    setLoading(true)
    try {
      const response = await fetch('/api/homepage/properties', { cache: 'no-store' })
      const body = await response.json().catch(() => null) as HomepagePropertyFeed | null
      if (!response.ok || !body || !Array.isArray(body.properties)) {
        setFeed({ status: 'error', properties: [], message: 'Published properties could not be loaded right now.' })
      } else {
        setFeed(body)
      }
    } catch {
      setFeed({ status: 'error', properties: [], message: 'Published properties could not be loaded right now.' })
    } finally {
      setLoading(false)
    }
  }

  const realProperties = feed.status === 'ready' ? feed.properties.slice(0, 3) : []
  const placeholders = Array.from({ length: 3 }, (_, index) => ({ index }))

  return (
    <section className={`${s.section} ${s.propertiesSection}`} id="properties" aria-labelledby="properties-title" data-feed-status={feed.status}>
      <div className={s.sectionInner}>
        <div className={`${s.sectionHeadingRow} ${s.reveal}`} data-reveal>
          <div>
            <p className={s.eyebrow}>Handpicked Melbourne stays</p>
            <h2 id="properties-title">Recommended Properties</h2>
          </div>
          {realProperties.length ? (
            <Link className={s.textLink} href="/properties">
              <span>View All Properties</span><img src="/homepage/icon-arrow-right.svg" alt="" />
            </Link>
          ) : (
            <span className={`${s.textLink} ${s.disabledLink}`} aria-disabled="true">Listings coming soon</span>
          )}
        </div>
        <p className={`${s.sectionIntro} ${s.reveal}`} data-reveal>
          We take pride in our dedicated service management team, offering locally managed furnished stays for business travellers and holidaymakers.
        </p>

        {feed.status === 'error' ? (
          <div className={s.feedNotice} role="alert">
            <span>{feed.message || 'Published properties could not be loaded right now.'}</span>
            <button type="button" onClick={retry} disabled={loading}>{loading ? 'Retrying…' : 'Retry'}</button>
          </div>
        ) : null}
        {feed.status === 'empty' ? (
          <p className={s.feedNotice} role="status">Our published listings are being prepared. Property details will appear here once they are ready.</p>
        ) : null}

        <div className={s.propertyGrid} aria-busy={loading}>
          {realProperties.length ? realProperties.map((property) => (
            <article className={`${s.propertyCard} ${s.reveal}`} data-reveal key={property.id}>
              <Link className={s.propertyMedia} href={property.detailHref} aria-label={`View ${property.title}`}>
                <img src={resolveAssetUrl(property.imageUrl) || placeholderImages[0]} alt="" />
                <span className={s.propertyMediaAction}>View published stay</span>
              </Link>
              <div className={s.propertyCopy}>
                <p className={s.location}>{property.region || 'Melbourne'}</p>
                <h3>{property.title}</h3>
                <p className={s.propertyMeta}>{propertyMeta(property)}</p>
                <Link className={s.textLink} href={property.detailHref}>
                  <span>View details</span><img src="/homepage/icon-arrow-right.svg" alt="" />
                </Link>
              </div>
            </article>
          )) : placeholders.map(({ index }) => (
            <article className={`${s.propertyCard} ${s.placeholderCard} ${s.reveal}`} data-reveal key={index}>
              <div className={s.propertyMedia} aria-hidden="true">
                <img src={placeholderImages[index]} alt="" />
                <span className={s.propertyMediaAction}>Layout preview only</span>
              </div>
              <div className={s.propertyCopy}>
                <p className={s.location}>Melbourne stay</p>
                <h3>Property details coming soon</h3>
                <p className={s.propertyMeta}>No price, availability or booking claim is shown.</p>
                <span className={`${s.textLink} ${s.disabledLink}`} aria-disabled="true">Not yet open</span>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
