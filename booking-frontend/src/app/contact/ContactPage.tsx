"use client"

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react'
import { postJSON } from '../../lib/api'
import { DEFAULT_HOMEPAGE_CONTENT } from '../../lib/homepage'
import HomeHeader from '../home/HomeHeader'
import SiteFooter from '../home/SiteFooter'
import home from '../home/home.module.css'
import s from './contact.module.css'

type FieldName = 'name' | 'email' | 'phone' | 'suburb' | 'propertyType' | 'currentUse' | 'message'
type FormValues = Record<FieldName, string>

const EMPTY_VALUES: FormValues = {
  name: '',
  email: '',
  phone: '',
  suburb: '',
  propertyType: '',
  currentUse: '',
  message: '',
}

const MAP_URL = 'https://www.google.com/maps/search/?api=1&query=130%20Gladstone%20St%2C%20South%20Melbourne%2C%20VIC%203205'

type ContactSelectProps = {
  name: 'propertyType' | 'currentUse'
  label: string
  options: readonly string[]
  value: string
  error?: string
  open: boolean
  triggerRef: RefObject<HTMLButtonElement>
  onOpenChange: (open: boolean) => void
  onChange: (value: string) => void
  onBlur: () => void
}

function ContactSelect({ name, label, options, value, error, open, triggerRef, onOpenChange, onChange, onBlur }: ContactSelectProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const onOpenChangeRef = useRef(onOpenChange)
  const selectedIndex = options.indexOf(value)
  const [activeIndex, setActiveIndex] = useState(Math.max(0, selectedIndex))
  const id = `contact-preview-${name}`
  const labelId = `${id}-label`
  const valueId = `${id}-value`
  const listboxId = `${id}-listbox`
  const errorId = `${id}-error`

  useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  }, [onOpenChange])

  useEffect(() => {
    if (!open) return
    let frame = 0
    const ensureVisible = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const popup = rootRef.current?.querySelector<HTMLElement>('[role="listbox"]')
        if (!popup) return
        const rect = popup.getBoundingClientRect()
        const headerBottom = document.querySelector<HTMLElement>('[data-header]')?.getBoundingClientRect().bottom || 0
        const topGuard = headerBottom + 10
        const bottomGuard = window.innerHeight - 12
        if (rect.top < topGuard) window.scrollBy({ top: rect.top - topGuard, behavior: 'auto' })
        else if (rect.bottom > bottomGuard) window.scrollBy({ top: rect.bottom - bottomGuard, behavior: 'auto' })
      })
    }
    const handleOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChangeRef.current(false)
    }
    ensureVisible()
    document.addEventListener('pointerdown', handleOutside)
    window.addEventListener('resize', ensureVisible)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', handleOutside)
      window.removeEventListener('resize', ensureVisible)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus({ preventScroll: true }))
    return () => window.cancelAnimationFrame(frame)
  }, [activeIndex, open])

  function openAt(index: number) {
    setActiveIndex(Math.max(0, Math.min(options.length - 1, index)))
    onOpenChange(true)
  }

  function close(returnFocus = false) {
    onOpenChange(false)
    if (returnFocus) window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }

  function choose(index: number) {
    const option = options[index]
    if (!option) return
    onChange(option)
    close(true)
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      openAt(open ? activeIndex + 1 : selectedIndex >= 0 ? selectedIndex + 1 : 0)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      openAt(open ? activeIndex - 1 : selectedIndex >= 0 ? selectedIndex - 1 : options.length - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      openAt(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      openAt(options.length - 1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (open) choose(activeIndex)
      else openAt(selectedIndex >= 0 ? selectedIndex : 0)
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      close(true)
    }
  }

  function handleOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index + 1) % options.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index - 1 + options.length) % options.length)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(options.length - 1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      choose(index)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
    } else if (event.key === 'Tab') {
      onOpenChange(false)
    }
  }

  return (
    <div
      ref={rootRef}
      className={`${s.field} ${s.selectField}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onOpenChange(false)
          onBlur()
        }
      }}
    >
      <span id={labelId}>{label} <b aria-hidden="true">*</b></span>
      <input type="hidden" name={name} value={value} />
      <button
        ref={triggerRef}
        id={id}
        className={`${s.selectTrigger} ${value ? '' : s.selectPlaceholder}`}
        type="button"
        role="combobox"
        aria-labelledby={`${labelId} ${valueId}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-required="true"
        aria-invalid={error ? 'true' : 'false'}
        aria-describedby={error ? errorId : undefined}
        onClick={() => open ? close() : openAt(selectedIndex >= 0 ? selectedIndex : 0)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span id={valueId}>{value || 'Choose one'}</span>
        <img src="/homepage/icon-arrow-right.svg" alt="" />
      </button>
      {open ? (
        <div className={s.selectPopover} id={listboxId} role="listbox" aria-labelledby={labelId}>
          {options.map((option, index) => (
            <button
              key={option}
              ref={(element) => { optionRefs.current[index] = element }}
              className={`${s.selectOption} ${option === value ? s.selectOptionSelected : ''}`}
              type="button"
              role="option"
              aria-selected={option === value}
              tabIndex={index === activeIndex ? 0 : -1}
              onClick={() => choose(index)}
              onKeyDown={(event) => handleOptionKeyDown(event, index)}
            >
              <span>{option}</span>
              {option === value ? <small>Selected</small> : null}
            </button>
          ))}
        </div>
      ) : null}
      {error ? <em id={errorId}>{error}</em> : null}
    </div>
  )
}

function validate(values: FormValues) {
  const errors: Partial<Record<FieldName, string>> = {}
  const name = values.name.trim()
  const email = values.email.trim()
  const phone = values.phone.trim()
  const suburb = values.suburb.trim()
  const message = values.message.trim()
  if (!name) errors.name = 'Enter your name.'
  else if (name.length > 161) errors.name = 'Name must be 161 characters or fewer.'
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 180) errors.email = 'Enter a valid email address.'
  if (phone && (phone.length < 7 || phone.length > 60)) errors.phone = 'Enter a valid phone number or leave this field blank.'
  if (!suburb) errors.suburb = 'Enter the property area or suburb.'
  else if (suburb.length > 120) errors.suburb = 'Property area must be 120 characters or fewer.'
  if (!values.propertyType) errors.propertyType = 'Choose a property type.'
  if (!values.currentUse) errors.currentUse = 'Choose the current use.'
  if (message.length < 10) errors.message = 'Share at least 10 characters about what you would like to explore.'
  else if (message.length > 1500) errors.message = 'Your note must be 1,500 characters or fewer.'
  return errors
}

export default function ContactPage() {
  const [values, setValues] = useState<FormValues>(EMPTY_VALUES)
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({})
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const [openSelect, setOpenSelect] = useState<'propertyType' | 'currentUse' | null>(null)
  const summaryRef = useRef<HTMLDivElement | null>(null)
  const submissionIdRef = useRef<string | null>(null)
  const inFlightRef = useRef(false)
  const propertyTypeRef = useRef<HTMLButtonElement | null>(null)
  const currentUseRef = useRef<HTMLButtonElement | null>(null)
  const content = DEFAULT_HOMEPAGE_CONTENT

  function update(field: FieldName, value: string) {
    setValues((current) => ({ ...current, [field]: value }))
    setErrors((current) => {
      const next = { ...current }
      delete next[field]
      return next
    })
    setFeedback(null)
  }

  function validateField(field: FieldName) {
    const error = validate(values)[field]
    setErrors((current) => {
      const next = { ...current }
      if (error) next[field] = error
      else delete next[field]
      return next
    })
  }

  async function submitEnquiry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlightRef.current) return
    const nextErrors = validate(values)
    setErrors(nextErrors)
    setFeedback(null)
    const firstError = Object.keys(nextErrors)[0] as FieldName | undefined
    if (firstError) {
      window.requestAnimationFrame(() => {
        summaryRef.current?.focus()
        document.getElementById(`contact-preview-${firstError}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      })
      setFeedback({ kind: 'error', message: 'Please review the highlighted fields. We have not received your enquiry yet.' })
      return
    }

    const submissionId = submissionIdRef.current || window.crypto.randomUUID()
    submissionIdRef.current = submissionId
    inFlightRef.current = true
    setSubmitting(true)
    try {
      const response = await postJSON<{ ok?: boolean; id?: string; duplicate?: boolean }>('/public/guest-site/contact-messages', {
        submission_id: submissionId,
        inquiry_type: 'property_management',
        name: values.name.trim(),
        email: values.email.trim().toLowerCase(),
        phone: values.phone.trim(),
        property_area: values.suburb.trim(),
        property_type: values.propertyType,
        current_use: values.currentUse,
        message: values.message.trim(),
      })
      if (!response?.ok || !response.id) throw new Error('property_enquiry_not_saved')
      setValues(EMPTY_VALUES)
      setErrors({})
      submissionIdRef.current = null
      setFeedback({ kind: 'success', message: 'Thank you — we’ve received your property enquiry and the MZ Property team can now review it.' })
    } catch {
      setFeedback({ kind: 'error', message: 'We couldn’t receive your enquiry right now. Your details are still here, so you can try again.' })
    } finally {
      inFlightRef.current = false
      setSubmitting(false)
    }
  }

  function field(name: FieldName, label: string, options: { type?: string; optional?: boolean; autoComplete?: string; placeholder?: string; maxLength?: number } = {}) {
    const error = errors[name]
    return (
      <label className={s.field} htmlFor={`contact-preview-${name}`}>
        <span>{label}{options.optional ? <small>Optional</small> : <b aria-hidden="true">*</b>}</span>
        <input
          id={`contact-preview-${name}`}
          name={name}
          type={options.type || 'text'}
          autoComplete={options.autoComplete}
          placeholder={options.placeholder}
          maxLength={options.maxLength}
          value={values[name]}
          onChange={(event) => update(name, event.target.value)}
          onBlur={() => validateField(name)}
          aria-invalid={error ? 'true' : 'false'}
          aria-describedby={error ? `contact-preview-${name}-error` : undefined}
          required={!options.optional}
        />
        {error ? <em id={`contact-preview-${name}-error`}>{error}</em> : null}
      </label>
    )
  }

  return (
    <div className={`${home.page} ${s.page}`}>
      <a className={home.skipLink} href="#contact-design">Skip to the property partnership enquiry</a>
      <HomeHeader />
      <main id="contact-design">
        <section className={s.hero} aria-labelledby="contact-page-title">
          <div>
            <p className={s.eyebrow}>Property management partnerships</p>
            <h1 id="contact-page-title">Let’s talk about your property.</h1>
          </div>
          <div className={s.heroIntro}>
            <p>Tell us about your property, what you need from a management partner, and how you would like to work together.</p>
            <p className={s.previewNotice}>Begin the conversation below so the MZ team can understand your property and the partnership you have in mind. Your enquiry goes only to our enquiries inbox—not to email.</p>
            <a href={`mailto:${content.contactEmail}`}>{content.contactEmail}</a>
            <a href={`tel:${content.contactPhone.replace(/[^+\d]/g, '')}`}>{content.contactPhone}</a>
          </div>
        </section>

        <section className={s.enquirySection} aria-labelledby="enquiry-title">
          <div className={s.sectionHeading}>
            <p className={s.eyebrow}>For property owners</p>
            <h2 id="enquiry-title">Start a conversation about your property.</h2>
            <p>A few practical details will help us understand the property, its current use, and the management support you are looking for.</p>
          </div>

          <div className={s.formShell} data-contact-form-shell>
            <aside className={s.formAside}>
              <p className={s.eyebrow}>Property management</p>
              <h3>A considered start.</h3>
              <p>Every property and owner has different priorities. Start with the essentials, then the MZ team can understand your goals and the way you would like to work.</p>
              <dl>
                <div><dt>Email</dt><dd><a href={`mailto:${content.contactEmail}`}>{content.contactEmail}</a></dd></div>
                <div><dt>Phone</dt><dd><a href={`tel:${content.contactPhone.replace(/[^+\d]/g, '')}`}>{content.contactPhone}</a></dd></div>
              </dl>
            </aside>

            <form className={s.previewForm} noValidate onSubmit={submitEnquiry} data-contact-form aria-busy={submitting}>
              {Object.keys(errors).length ? (
                <div className={s.errorSummary} role="alert" tabIndex={-1} ref={summaryRef}>
                  <strong>Please review the highlighted fields.</strong>
                  <span>We have not received your enquiry yet.</span>
                </div>
              ) : null}

              <div className={s.twoColumn}>
                {field('name', 'Name', { autoComplete: 'name', maxLength: 161 })}
                {field('email', 'Email', { type: 'email', autoComplete: 'email', maxLength: 180 })}
              </div>
              <div className={s.twoColumn}>
                {field('phone', 'Phone', { type: 'tel', optional: true, autoComplete: 'tel', maxLength: 60 })}
                {field('suburb', 'Property area / suburb', { placeholder: 'South Melbourne', maxLength: 120 })}
              </div>
              <div className={s.twoColumn}>
                <ContactSelect name="propertyType" label="Property type" options={['Apartment', 'Townhouse', 'House', 'Other']} value={values.propertyType} error={errors.propertyType} open={openSelect === 'propertyType'} triggerRef={propertyTypeRef} onOpenChange={(open) => setOpenSelect(open ? 'propertyType' : null)} onChange={(value) => update('propertyType', value)} onBlur={() => validateField('propertyType')} />
                <ContactSelect name="currentUse" label="Current use" options={['Short-term rental', 'Long-term rental', 'Owner-occupied', 'Vacant or preparing', 'Other']} value={values.currentUse} error={errors.currentUse} open={openSelect === 'currentUse'} triggerRef={currentUseRef} onOpenChange={(open) => setOpenSelect(open ? 'currentUse' : null)} onChange={(value) => update('currentUse', value)} onBlur={() => validateField('currentUse')} />
              </div>

              <label className={s.field} htmlFor="contact-preview-message">
                <span>What would you like to explore together? <b aria-hidden="true">*</b></span>
                <textarea id="contact-preview-message" name="message" rows={6} maxLength={1500} value={values.message} onChange={(event) => update('message', event.target.value)} onBlur={() => validateField('message')} aria-invalid={errors.message ? 'true' : 'false'} aria-describedby={errors.message ? 'contact-preview-message-error' : undefined} required />
                {errors.message ? <em id="contact-preview-message-error">{errors.message}</em> : null}
              </label>

              <div className={s.formFooter}>
                <button className={home.button} type="submit" disabled={submitting} aria-describedby="contact-enquiry-note contact-enquiry-feedback">{submitting ? 'Opening the conversation…' : 'Let’s talk'}</button>
                <p id="contact-enquiry-note">Your enquiry goes to the MZ Property team’s enquiries inbox, not to email.</p>
              </div>
              <p className={`${s.formFeedback} ${feedback?.kind === 'success' ? s.formSuccess : feedback ? s.formFailure : ''}`} id="contact-enquiry-feedback" role={feedback?.kind === 'error' ? 'alert' : 'status'} aria-live="polite">{feedback?.message || ''}</p>
            </form>
          </div>

          <section className={s.guestPaths} data-guest-paths aria-labelledby="guest-paths-title">
            <div className={s.guestIntro}>
              <p className={s.eyebrow}>Looking for a stay?</p>
              <h3 id="guest-paths-title">Guest help, kept simple.</h3>
            </div>
            <article>
              <span>New bookings</span>
              <p>Browse the current property collection and continue from the stay that suits you.</p>
              <a href="/#properties">Explore Our Properties <span aria-hidden="true">→</span></a>
            </article>
            <article>
              <span>Existing bookings</span>
              <p>For help with an existing stay, contact the MZ team through the verified channels below.</p>
              <a href={`mailto:${content.contactEmail}`}>{content.contactEmail}</a>
              <a href={`tel:${content.contactPhone.replace(/[^+\d]/g, '')}`}>{content.contactPhone}</a>
            </article>
          </section>
        </section>

        <section className={s.locationSection} aria-labelledby="location-title">
          <div className={s.locationCopy}>
            <p className={s.eyebrow}>Visit our office</p>
            <h2 id="location-title">South Melbourne,<br /> close to the city.</h2>
            <address>{content.contactAddress}</address>
            <p>Please contact the team before planning a visit; walk-in availability and office hours are not listed here.</p>
            <a className={s.directionsLink} href={MAP_URL} target="_blank" rel="noreferrer">Open this address in Google Maps <span aria-hidden="true">↗</span></a>
          </div>
          <div className={s.mapPlaceholder} role="img" aria-label={`Static location placeholder for ${content.contactAddress}`}>
            <span>Location preview</span>
            <strong>130</strong>
            <b>Gladstone St</b>
            <small>South Melbourne · VIC 3205</small>
            <p>Office address preview—not a live map.</p>
          </div>
        </section>
      </main>
      <SiteFooter content={content} footerLabel="Contact MZ Property" />
    </div>
  )
}
