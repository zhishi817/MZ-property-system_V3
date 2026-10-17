import Link from 'next/link'
import { HOMEPAGE_SEARCH_AREAS, homepageSearchFromQuery, homepageSearchQuery } from '../../lib/homepage'
import HomeHeader from '../home/HomeHeader'
import s from './page.module.css'

function formatStayDate(value: string) {
  if (!value) return 'Not selected'
  const [year, month, day] = value.split('-').map(Number)
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Melbourne',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, day, 12)))
}

export default function PropertyDetailsPlaceholder({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const search = homepageSearchFromQuery(searchParams)
  const area = HOMEPAGE_SEARCH_AREAS.find((option) => option.value === search.area)?.label || 'All Melbourne'
  const returnHref = `/?${homepageSearchQuery(search)}#stay-search`

  return (
    <div className={s.page}>
      <HomeHeader />
      <main className={s.main}>
        <section className={s.card} aria-labelledby="details-title">
          <p className={s.eyebrow}>Stay details preview</p>
          <h1 id="details-title">Property details are coming soon.</h1>
          <p className={s.intro}>Your stay preferences have been kept, but no property or live availability has been selected. This placeholder will become the property-details entry when the booking experience is connected.</p>
          <dl className={s.summary}>
            <div><dt>Area</dt><dd>{area}</dd></div>
            <div><dt>Check-in</dt><dd>{formatStayDate(search.checkin)}</dd></div>
            <div><dt>Check-out</dt><dd>{formatStayDate(search.checkout)}</dd></div>
            <div><dt>Guests</dt><dd>{search.guests} {search.guests === '1' ? 'guest' : 'guests'}</dd></div>
          </dl>
          <div className={s.actions}>
            <Link className={s.primary} href={returnHref}>Change search</Link>
            <Link className={s.secondary} href="/#contact">Contact us</Link>
          </div>
          <p className={s.note}>No availability search, reservation or payment has been performed.</p>
        </section>
      </main>
    </div>
  )
}
