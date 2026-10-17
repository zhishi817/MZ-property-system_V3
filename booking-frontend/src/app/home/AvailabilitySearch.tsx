"use client"

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import {
  HOMEPAGE_SEARCH_AREAS,
  addIsoCalendarDays,
  homepageSearchQuery,
  melbourneTodayISO,
  normalizeHomepageSearch,
  validateHomepageSearch,
  type HomepageSearchErrors,
  type HomepageSearchInput,
} from '../../lib/homepage'
import EnglishDatePicker from './EnglishDatePicker'
import EnglishSelect from './EnglishSelect'
import s from './home.module.css'

const GUEST_OPTIONS = Array.from({ length: 8 }, (_, index) => {
  const count = index + 1
  return { value: String(count), label: `${count} ${count === 1 ? 'guest' : 'guests'}` }
})

type SearchPopover = 'area' | 'checkin' | 'checkout' | 'guests' | null

export default function AvailabilitySearch({ initialSearch }: { initialSearch: HomepageSearchInput }) {
  const router = useRouter()
  const [values, setValues] = useState(() => normalizeHomepageSearch(initialSearch))
  const [errors, setErrors] = useState<HomepageSearchErrors>({})
  const [activePopover, setActivePopover] = useState<SearchPopover>(null)
  const areaRef = useRef<HTMLButtonElement | null>(null)
  const checkinRef = useRef<HTMLButtonElement | null>(null)
  const checkoutRef = useRef<HTMLButtonElement | null>(null)
  const guestsRef = useRef<HTMLButtonElement | null>(null)
  const refs = {
    area: areaRef,
    checkin: checkinRef,
    checkout: checkoutRef,
    guests: guestsRef,
  }
  const today = melbourneTodayISO()

  function update(field: keyof HomepageSearchInput, value: string) {
    setValues((current) => {
      if (field === 'checkin' && current.checkout && current.checkout <= value) {
        return { ...current, checkin: value, checkout: '' }
      }
      return { ...current, [field]: value }
    })
    setErrors((current) => field === 'checkin'
      ? { ...current, checkin: undefined, checkout: undefined }
      : { ...current, [field]: undefined })
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextErrors = validateHomepageSearch(values, today)
    setErrors(nextErrors)
    const firstError = (Object.keys(nextErrors) as Array<keyof HomepageSearchInput>)[0]
    if (firstError) {
      refs[firstError].current?.focus()
      return
    }
    const query = homepageSearchQuery(values)
    window.history.replaceState(window.history.state, '', `/?${query}`)
    router.push(`/properties?${query}`)
  }

  return (
    <div className={s.availabilitySearchWrap} id="stay-search">
      <form className={s.availabilityForm} data-stay-search noValidate onSubmit={submit}>
        <EnglishSelect id="stay-area" label="Area" value={values.area} options={HOMEPAGE_SEARCH_AREAS} open={activePopover === 'area'} error={errors.area} triggerRef={areaRef} onOpenChange={(open) => setActivePopover(open ? 'area' : null)} onChange={(value) => update('area', value)} />
        <EnglishDatePicker id="stay-checkin" label="Check-in" value={values.checkin} min={today} today={today} open={activePopover === 'checkin'} error={errors.checkin} triggerRef={checkinRef} onOpenChange={(open) => setActivePopover(open ? 'checkin' : null)} onChange={(value) => update('checkin', value)} />
        <EnglishDatePicker id="stay-checkout" label="Check-out" value={values.checkout} min={values.checkin ? addIsoCalendarDays(values.checkin, 1) : today} today={today} open={activePopover === 'checkout'} error={errors.checkout} triggerRef={checkoutRef} onOpenChange={(open) => setActivePopover(open ? 'checkout' : null)} onChange={(value) => update('checkout', value)} />
        <EnglishSelect id="stay-guests" label="Guests" value={values.guests} options={GUEST_OPTIONS} open={activePopover === 'guests'} align="right" error={errors.guests} triggerRef={guestsRef} onOpenChange={(open) => setActivePopover(open ? 'guests' : null)} onChange={(value) => update('guests', value)} />
        <button className={s.availabilitySubmit} type="submit">
          <span>View matching properties</span>
          <img src="/homepage/icon-arrow-right.svg" alt="" />
        </button>
      </form>
      <p className={s.availabilityNote}>Live availability is not connected yet. Continue to the property collection with your selected stay preferences.</p>
    </div>
  )
}
