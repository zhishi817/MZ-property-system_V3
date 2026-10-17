"use client"

import { useEffect, useMemo, useRef, useState } from 'react'
import { HOMEPAGE_PROPERTIES_MANAGED_FALLBACK_COUNT, type HomepageBusinessStats, type HomepageContentFeed, type HomepagePropertyFeed, type HomepageSearchInput } from '../../lib/homepage'
import { resolveAssetUrl } from '../../lib/api'
import AvailabilitySearch from './AvailabilitySearch'
import ChatDemo from './ChatDemo'
import ContactForm from './ContactForm'
import HomeHeader from './HomeHeader'
import PropertyShowcase from './PropertyShowcase'
import SiteFooter from './SiteFooter'
import TestimonialCarousel from './TestimonialCarousel'
import s from './home.module.css'

export default function HomePage({ initialContent, initialFeed, initialSearch, initialYearsInBusiness, initialBusinessStats }: { initialContent: HomepageContentFeed; initialFeed: HomepagePropertyFeed; initialSearch: HomepageSearchInput; initialYearsInBusiness: number; initialBusinessStats: HomepageBusinessStats }) {
  const pageRef = useRef<HTMLDivElement | null>(null)
  const [activeHeroImage, setActiveHeroImage] = useState(0)
  const [heroPaused, setHeroPaused] = useState(false)
  const content = initialContent.content
  const heroImages = useMemo(() => content.heroImages.map(resolveAssetUrl).filter(Boolean), [content.heroImages])
  const heroTitleParts = content.heroTitle.includes(',')
    ? [`${content.heroTitle.split(',')[0].trim()},`, content.heroTitle.split(',').slice(1).join(',').trim()]
    : [content.heroTitle]
  const propertyCountIsFallback = initialBusinessStats.propertiesManagedToDate == null
  const propertiesManagedToDate = initialBusinessStats.propertiesManagedToDate ?? HOMEPAGE_PROPERTIES_MANAGED_FALLBACK_COUNT
  const records = [
    { value: initialYearsInBusiness, suffix: '', fallback: '', grouped: false, lines: ['Years in', 'Business'] },
    { value: propertiesManagedToDate, suffix: '', fallback: '', grouped: false, lines: ['Properties managed', 'to date'] },
    { value: 15800, suffix: '+', fallback: '', grouped: true, lines: ['Reviews on', 'Airbnb'] },
    { value: 4.8, suffix: '/5', fallback: '', grouped: false, lines: ['Platform', 'Rating'] },
  ]
  const statsCheckedAt = initialBusinessStats.asOf
    ? new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(initialBusinessStats.asOf))
    : ''
  const qualities = [
    ['icon-home.svg', 'Expert Property Management', `With ${initialYearsInBusiness} years of experience, we handle listings, maintenance and guest communication for owners.`],
    ['icon-sparkles.svg', 'Premium Cleaning Standards', 'Our cleaning team works to maintain welcoming spaces while preserving each property’s condition.'],
    ['icon-users.svg', 'Exceptional Guest Satisfaction', 'The business reports more than 15,800 guest reviews across managed stays.'],
    ['icon-support.svg', 'Dedicated Support Team', 'Our support team assists owners and guests throughout the property-management and stay journey.'],
  ] as const

  useEffect(() => {
    if (activeHeroImage >= heroImages.length) setActiveHeroImage(0)
    if (heroImages.length <= 1 || heroPaused || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const timer = window.setInterval(() => setActiveHeroImage((current) => (current + 1) % heroImages.length), 6500)
    return () => window.clearInterval(timer)
  }, [activeHeroImage, heroImages.length, heroPaused])

  useEffect(() => {
    const root = pageRef.current
    if (!root) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const revealElements = [...root.querySelectorAll<HTMLElement>('[data-reveal]')]
    if (reducedMotion || !('IntersectionObserver' in window)) {
      revealElements.forEach((element) => element.classList.add(s.visible))
      return
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        entry.target.classList.add(s.visible)
        observer.unobserve(entry.target)
      })
    }, { threshold: 0.13, rootMargin: '0px 0px -4% 0px' })
    revealElements.forEach((element) => observer.observe(element))
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const root = pageRef.current
    const group = root?.querySelector<HTMLElement>('[data-counter-group]')
    if (!group) return
    let played = false
    let frame = 0
    const counters = [...group.querySelectorAll<HTMLElement>('[data-counter]')]
    const setFinal = () => counters.forEach((counter) => {
      counter.textContent = counter.dataset.value
        ? `${counter.dataset.grouped === 'true' ? Number(counter.dataset.value).toLocaleString('en-AU') : counter.dataset.value}${counter.dataset.suffix || ''}`
        : counter.dataset.fallback || 'Unavailable'
    })
    const play = () => {
      if (played) return
      played = true
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setFinal()
        return
      }
      const start = performance.now()
      const tick = (now: number) => {
        const progress = Math.min(1, (now - start) / 1400)
        const eased = 1 - Math.pow(1 - progress, 3)
        counters.forEach((counter) => {
          if (!counter.dataset.value) {
            counter.textContent = counter.dataset.fallback || 'Unavailable'
            return
          }
          const target = Number(counter.dataset.value || 0)
          const value = Number.isInteger(target) ? Math.round(target * eased) : (target * eased).toFixed(1)
          const displayValue = counter.dataset.grouped === 'true' ? Number(value).toLocaleString('en-AU') : value
          counter.textContent = `${displayValue}${counter.dataset.suffix || ''}`
        })
        if (progress < 1) frame = window.requestAnimationFrame(tick)
        else setFinal()
      }
      frame = window.requestAnimationFrame(tick)
    }
    if (!('IntersectionObserver' in window)) {
      play()
      return () => window.cancelAnimationFrame(frame)
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        play()
        observer.disconnect()
      }
    }, { threshold: 0.35 })
    observer.observe(group)
    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <div ref={pageRef} className={s.page} data-content-status={initialContent.status}>
      <a className={s.skipLink} href="#main-content">Skip to content</a>
      <HomeHeader />
      <main id="main-content">
        <section className={s.hero} id="home" aria-labelledby="hero-title" onMouseEnter={() => setHeroPaused(true)} onMouseLeave={() => setHeroPaused(false)} onFocus={() => setHeroPaused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeroPaused(false) }}>
          {heroImages.map((image, index) => (
            <img
              className={`${s.heroMedia} ${index === activeHeroImage ? s.heroMediaActive : ''}`}
              src={image}
              alt=""
              aria-hidden="true"
              fetchPriority={index === 0 ? 'high' : 'auto'}
              key={`${image}-${index}`}
            />
          ))}
          <div className={s.heroShade} aria-hidden="true" />
          <div className={s.heroPanel}>
            <p className={s.eyebrow}>Melbourne stays &amp; property care</p>
            <h1 id="hero-title">{heroTitleParts.map((part, index) => <span key={`${part}-${index}`}>{part}{index < heroTitleParts.length - 1 ? <br /> : null}</span>)}</h1>
            <p>{content.heroSubtitle}</p>
            <a className={s.button} href="#properties"><span>Find Properties</span><img src="/homepage/icon-arrow-right.svg" alt="" /></a>
          </div>
          {heroImages.length > 1 ? (
            <div className={s.heroDots} aria-label="Choose hero image">
              {heroImages.map((image, index) => (
                <button
                  className={`${s.heroDot} ${index === activeHeroImage ? s.active : ''}`}
                  type="button"
                  aria-label={`Show hero image ${index + 1}`}
                  aria-current={index === activeHeroImage ? 'true' : undefined}
                  onClick={() => setActiveHeroImage(index)}
                  key={`${image}-dot-${index}`}
                />
              ))}
            </div>
          ) : null}
          <a className={s.scrollCue} href="#properties" aria-label="Scroll to recommended properties"><span>Discover</span><span className={s.scrollLine} aria-hidden="true" /></a>
        </section>

        <AvailabilitySearch initialSearch={initialSearch} />

        <PropertyShowcase initialFeed={initialFeed} />

        <section className={s.records} id="records" aria-labelledby="records-title">
          <div className={`${s.recordsInner} ${s.reveal}`} data-reveal>
            <div className={s.recordsHeading}><p className={s.eyebrow}>Us in numbers</p><h2 id="records-title">Our Records</h2></div>
            <dl className={s.recordGrid} data-counter-group>
              {records.map((record) => (
                <div className={s.recordItem} key={record.lines.join('-')}>
                  <dd><span data-counter data-value={record.value} data-fallback={record.fallback} data-grouped={record.grouped} data-suffix={record.suffix}>{record.grouped ? record.value.toLocaleString('en-AU') : record.value}{record.suffix}</span></dd>
                  <dt>{record.lines[0]}<br />{record.lines[1]}</dt>
                </div>
              ))}
            </dl>
          </div>
          <p className={s.recordsNote}>{propertyCountIsFallback
            ? `The cumulative property total currently uses the user-provided temporary fallback of ${HOMEPAGE_PROPERTIES_MANAGED_FALLBACK_COUNT} until the public aggregate is available; it is not a live availability count. Years are calculated from October 2018; review and rating figures remain pending business confirmation.`
            : `The cumulative property total includes archived management records and is not live availability${statsCheckedAt ? `; data checked ${statsCheckedAt}` : ''}. Review and rating figures remain pending business confirmation.`}</p>
        </section>

        <section className={`${s.section} ${s.storySection}`} id="story" aria-labelledby="story-title">
          <div className={`${s.storyGrid} ${s.sectionInner}`}>
            <figure className={`${s.storyImage} ${s.reveal}`} data-reveal><img src="/homepage/story.jpg" alt="Styled living room table with flowers and books" /></figure>
            <div className={`${s.storyCopy} ${s.reveal}`} data-reveal>
              <p className={s.eyebrow}>Meet MZ Property</p>
              <h2 id="story-title">Our Story</h2>
              <p>{content.storyIntro}</p>
              <h3>Our Mission</h3>
              <p>{content.missionOwner}</p>
              <p>{content.missionGuest}</p>
              <a className={`${s.button} ${s.buttonOutline}`} href="/our-story">Read our story</a>
            </div>
          </div>
        </section>

        <section className={`${s.section} ${s.qualitiesSection}`} id="qualities" aria-labelledby="qualities-title">
          <div className={`${s.qualitiesShell} ${s.sectionInner}`}>
            <div className={`${s.qualitiesContent} ${s.reveal}`} data-reveal>
              <p className={s.eyebrow}>Our Qualities</p>
              <h2 id="qualities-title">Why Choose Us</h2>
              <div className={s.qualityGrid}>
                {qualities.map(([icon, title, body]) => (
                  <article className={s.qualityCard} key={title}>
                    <img src={`/homepage/${icon}`} alt="" />
                    <div><h3>{title}</h3><p>{body}</p></div>
                  </article>
                ))}
              </div>
              <p className={s.contentNote}>Service figures and availability commitments are carried over from earlier website content and remain subject to business confirmation.</p>
            </div>
            <figure className={`${s.qualitiesImage} ${s.reveal}`} data-reveal><img src="/homepage/qualities.jpg" alt="Bedroom styled with warm rust-toned throw and greenery" /></figure>
          </div>
        </section>

        <TestimonialCarousel />

        <section className={s.contactSection} id="contact" aria-labelledby="contact-title">
          <figure className={`${s.contactImage} ${s.reveal}`} data-reveal><img src="/homepage/contact.jpg" alt="Cafe table with flowers, glasses and cups" /></figure>
          <div className={`${s.contactPanel} ${s.reveal}`} data-reveal>
            <p className={s.eyebrow}>Start a conversation</p>
            <h2 id="contact-title">Ready to List or stay with us?</h2>
            <p>Get in touch with us today and let’s make it happen.</p>
            <ContactForm />
            <ChatDemo />
          </div>
        </section>
      </main>

      <SiteFooter content={content} />
    </div>
  )
}
