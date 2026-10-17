"use client"

import { useEffect, useRef } from 'react'
import { DEFAULT_HOMEPAGE_CONTENT } from '../../lib/homepage'
import HomeHeader from '../home/HomeHeader'
import SiteFooter from '../home/SiteFooter'
import home from '../home/home.module.css'
import s from './ourStory.module.css'

function StoryImage({ src, alt, caption, className = '', eager = false }: { src: string; alt: string; caption: string; className?: string; eager?: boolean }) {
  return (
    <figure className={`${s.storyImage} ${className} ${s.reveal}`} data-reveal>
      <img
        src={src}
        alt={alt}
        width="1536"
        height="1024"
        loading={eager ? 'eager' : 'lazy'}
        fetchPriority={eager ? 'high' : 'auto'}
        decoding="async"
        data-story-image
      />
      <figcaption>{caption}</figcaption>
    </figure>
  )
}

export default function OurStoryPage() {
  const pageRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const root = pageRef.current
    if (!root) return
    const elements = [...root.querySelectorAll<HTMLElement>('[data-reveal]')]
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
      elements.forEach((element) => element.classList.add(s.visible))
      return
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        entry.target.classList.add(s.visible)
        observer.unobserve(entry.target)
      })
    }, { threshold: 0.12, rootMargin: '0px 0px -5% 0px' })
    elements.forEach((element) => observer.observe(element))
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={pageRef} className={`${home.page} ${s.page}`}>
      <a className={home.skipLink} href="#story-content">Skip to story</a>
      <HomeHeader />
      <main id="story-content">
        <section className={s.hero} id="story-top" aria-labelledby="story-page-title">
          <div className={`${s.heroCopy} ${s.reveal}`} data-reveal>
            <p className={s.eyebrow}>Our Story · Melbourne, since 2018</p>
            <h1 id="story-page-title">Built one property<br />{' '}at a time.</h1>
            <p className={s.heroIntro}>MZ Property has grown by staying close to the work: caring for each property, listening to each guest and moving forward steadily.</p>
            <a className={s.textLink} href="#beginning">Start at the beginning <span aria-hidden="true">↓</span></a>
          </div>
          <StoryImage
            src="/our-story/beginning-apartment.jpg"
            alt="Illustrative apartment living room with a Melbourne city view"
            caption="Illustrative imagery · AI-generated apartment setting, not an MZ Property listing or archive photograph."
            className={s.heroPhoto}
            eager
          />
          <p className={s.heroNote}>A practical beginning<br />in Southbank.</p>
        </section>

        <section className={`${s.chapter} ${s.beginning}`} id="beginning" aria-labelledby="beginning-title">
          <div className={`${s.chapterNumber} ${s.reveal}`} data-reveal aria-hidden="true">01</div>
          <div className={`${s.chapterHeading} ${s.reveal}`} data-reveal>
            <p className={s.eyebrow}>Why we started</p>
            <h2 id="beginning-title">A small beginning<br />in Southbank</h2>
          </div>
          <div className={`${s.chapterBody} ${s.reveal}`} data-reveal>
            <p>In 2018, after selling his fish and chip shop in Melbourne and taking some time off, our founder, Ming, began a new chapter. That October, MZ Property started with a small apartment in Southbank and just two or three properties to care for.</p>
            <p>In those early days, Ming handled every part of the work himself. He washed the linen, cleaned the rooms and welcomed guests in person each day. Many were backpackers arriving in Melbourne from different parts of the world.</p>
            <p>There was no complicated plan behind it. The aim was simply to manage each property with care and give every guest a comfortable place to stay. That practical, personal beginning still shapes how we think about hospitality and property care today.</p>
          </div>
        </section>

        <section className={s.growth} id="growth" aria-labelledby="growth-title">
          <div className={s.growthIntro}>
            <div className={`${s.growthHeading} ${s.reveal}`} data-reveal>
              <span className={s.growthNumber} aria-hidden="true">02</span>
              <p className={`${s.eyebrow} ${s.eyebrowLight}`}>How we grew</p>
              <h2 id="growth-title">Growth came<br />step by step.</h2>
            </div>
            <div className={`${s.growthBody} ${s.reveal}`} data-reveal>
              <p>By 2020, MZ was caring for around 20 to 30 properties and had begun working with a commercial linen and laundry provider. When COVID arrived, the team kept looking after owners’ properties, with careful cleaning and disinfection remaining central to the work.</p>
              <p>By 2022, the portfolio had reached 50 properties. A team change then meant restarting from around 20 properties. Rather than rushing to rebuild, MZ returned to the same steady approach that had shaped the beginning.</p>
              <p>The portfolio grew to around 60 properties across 2022 and 2023, then to 80 in 2024 and 100 in 2025. Today, MZ cares for approximately 120 properties. Each stage has been built through consistent work, close attention and a willingness to begin again when needed.</p>
            </div>
          </div>
          <div className={`${s.timeline} ${s.reveal}`} data-reveal aria-label="MZ Property growth timeline">
            <div><strong>2018</strong><span>2–3 properties</span><small>Southbank beginning</small></div>
            <div><strong>2020</strong><span>20–30 properties</span><small>Commercial linen partnership</small></div>
            <div><strong>2022</strong><span>50 → 20</span><small>Team change and a fresh start</small></div>
            <div><strong>2022–23</strong><span>60 properties</span><small>Steady rebuilding</small></div>
            <div><strong>2024</strong><span>80 properties</span><small>Continued growth</small></div>
            <div><strong>2025</strong><span>100 properties</span><small>A new milestone</small></div>
            <div className={s.timelineCurrent}><strong>Today</strong><span>~120 properties</span><small>Still moving carefully</small></div>
          </div>
          <StoryImage
            src="/our-story/growth-balcony.jpg"
            alt="Illustrative apartment balcony overlooking a Melbourne city skyline"
            caption="Illustrative imagery · AI-generated city and balcony setting, not a bookable property photograph."
            className={s.widePhoto}
          />
        </section>

        <section className={`${s.chapter} ${s.care}`} id="care" aria-labelledby="care-title">
          <div className={`${s.chapterNumber} ${s.reveal}`} data-reveal aria-hidden="true">03</div>
          <div className={`${s.chapterHeading} ${s.reveal}`} data-reveal>
            <p className={s.eyebrow}>Behind every stay</p>
            <h2 id="care-title">Good stays begin<br />between bookings.</h2>
          </div>
          <div className={`${s.chapterBody} ${s.reveal}`} data-reveal>
            <p>After a guest checks out, our cleaning team prepares the property, including cleaning, disinfecting and changing the linen. A separate inspection team then checks the property, tops up essential consumables and notes any furniture or everyday items that may need repair or replacement.</p>
            <p>Where possible, maintenance is scheduled in the gap between stays to reduce disruption for guests. Our regular care also includes a deeper clean and maintenance review every three months, with walls refreshed and selected furniture replaced as needed each year.</p>
            <p>The details can vary from property to property, but the purpose stays the same: prepare each property carefully for the next arrival while helping owners look after its condition over time.</p>
          </div>
          <StoryImage
            src="/our-story/care-preparation.jpg"
            alt="Illustrative close-up of an anonymous person preparing fresh bed linen"
            caption="Illustrative imagery · AI-generated preparation scene; the person shown is not an MZ Property employee."
            className={s.carePhoto}
          />
        </section>

        <section className={s.lessons} id="lessons" aria-labelledby="lessons-title">
          <div className={s.lessonsVisual}>
            <StoryImage
              src="/our-story/attention-to-detail.jpg"
              alt="Illustrative bedside setting with towels and guest amenities"
              caption="Illustrative imagery · AI-generated guest-amenity detail, not a bookable property photograph."
              className={s.portraitPhoto}
            />
            <blockquote className={`${s.pullQuote} ${s.reveal}`} data-reveal>“Pay attention, follow through and make the next stay better.”</blockquote>
          </div>
          <div className={`${s.lessonsCopy} ${s.reveal}`} data-reveal>
            <p className={s.eyebrow}>What we’ve learned</p>
            <h2 id="lessons-title">Listening makes<br />the work better.</h2>
            <p>Every guest comment gives us something to learn from. Positive feedback tells us what is working; thoughtful criticism shows us where the experience can improve. We take both seriously.</p>
            <p>Guest satisfaction and an owner’s rental performance are closely connected. A well-prepared property and a consistent arrival experience can support better reviews, while strong reviews can help a property earn trust with future guests. They can contribute to future bookings and revenue, but no single review or process can guarantee a particular result.</p>
            <p>We carry the practical lessons from guests, owners and the properties themselves into the next stay. The principle is simple: pay attention, follow through and make the next stay better than the last.</p>
          </div>
        </section>

        <section className={s.contactCta} id="story-contact" aria-labelledby="story-contact-title">
          <p className={`${s.eyebrow} ${s.eyebrowLight} ${s.reveal}`} data-reveal>Start a conversation</p>
          <h2 id="story-contact-title" className={s.reveal} data-reveal>Let’s look after<br />what matters.</h2>
          <p className={s.reveal} data-reveal>Whether you’re planning a stay or looking for thoughtful property management, we’d be glad to hear from you.</p>
          <a className={`${s.contactButton} ${s.reveal}`} data-reveal href="/contact">Contact MZ Property <span aria-hidden="true">→</span></a>
        </section>
      </main>
      <SiteFooter content={DEFAULT_HOMEPAGE_CONTENT} />
    </div>
  )
}
