"use client"

import { useRef, useState } from 'react'
import { postJSON } from '../../lib/api'
import { normalizeHomepageContact, validateHomepageContact, type HomepageContactErrors, type HomepageContactInput } from '../../lib/homepage'
import s from './home.module.css'

const EMPTY_FORM: HomepageContactInput = { firstName: '', lastName: '', email: '', message: '' }

export default function ContactForm() {
  const [values, setValues] = useState(EMPTY_FORM)
  const [errors, setErrors] = useState<HomepageContactErrors>({})
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const submissionIdRef = useRef<string | null>(null)
  const inFlightRef = useRef(false)

  function update(field: keyof HomepageContactInput, value: string) {
    setValues((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
    setFeedback(null)
  }

  function validateField(field: keyof HomepageContactInput) {
    const nextErrors = validateHomepageContact(values)
    setErrors((current) => ({ ...current, [field]: nextErrors[field] }))
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlightRef.current) return
    const nextErrors = validateHomepageContact(values)
    setErrors(nextErrors)
    const firstError = (Object.keys(nextErrors) as Array<keyof HomepageContactInput>)[0]
    if (firstError) {
      document.getElementById(`contact-${firstError === 'message' ? 'message' : firstError}`)?.focus()
      setFeedback({ kind: 'error', message: 'Please review the highlighted fields. Your message has not been sent.' })
      return
    }

    const normalized = normalizeHomepageContact(values)
    const submissionId = submissionIdRef.current || window.crypto.randomUUID()
    submissionIdRef.current = submissionId
    inFlightRef.current = true
    setSubmitting(true)
    setFeedback(null)
    try {
      const response = await postJSON<{ ok?: boolean; id?: string; duplicate?: boolean }>('/public/guest-site/contact-messages', {
        submission_id: submissionId,
        first_name: normalized.firstName,
        last_name: normalized.lastName,
        email: normalized.email,
        message: normalized.message,
      })
      if (!response?.ok || !response.id) throw new Error('contact_message_not_saved')
      setValues(EMPTY_FORM)
      setErrors({})
      submissionIdRef.current = null
      setFeedback({ kind: 'success', message: 'Thank you — your message has been saved for the MZ Property team to review.' })
    } catch {
      setFeedback({ kind: 'error', message: 'We could not save your message right now. Your details are still in the form, so you can try again.' })
    } finally {
      inFlightRef.current = false
      setSubmitting(false)
    }
  }

  const field = (name: keyof HomepageContactInput, label: string, type = 'text') => (
    <label htmlFor={`contact-${name}`}>
      {label} <span aria-hidden="true">*</span>
      <input
        id={`contact-${name}`}
        name={name}
        type={type}
        autoComplete={name === 'firstName' ? 'given-name' : name === 'lastName' ? 'family-name' : 'email'}
        value={values[name]}
        onChange={(event) => update(name, event.target.value)}
        onBlur={() => validateField(name)}
        aria-invalid={errors[name] ? 'true' : 'false'}
        aria-describedby={errors[name] ? `contact-${name}-error` : undefined}
        required
      />
      {errors[name] ? <span className={s.fieldError} id={`contact-${name}-error`}>{errors[name]}</span> : null}
    </label>
  )

  return (
    <form className={s.contactForm} noValidate onSubmit={submit}>
      <div className={s.formRow}>
        {field('firstName', 'First name')}
        {field('lastName', 'Last name')}
      </div>
      {field('email', 'Email', 'email')}
      <label htmlFor="contact-message">
        Message <span aria-hidden="true">*</span>
        <textarea
          id="contact-message"
          name="message"
          rows={5}
          value={values.message}
          onChange={(event) => update('message', event.target.value)}
          onBlur={() => validateField('message')}
          aria-invalid={errors.message ? 'true' : 'false'}
          aria-describedby={errors.message ? 'contact-message-error' : undefined}
          required
        />
        {errors.message ? <span className={s.fieldError} id="contact-message-error">{errors.message}</span> : null}
      </label>
      <button className={`${s.button} ${s.formSubmit}`} type="submit" disabled={submitting} aria-describedby="contact-form-note contact-form-feedback">
        {submitting ? 'Saving…' : 'Send message'}
      </button>
      <p className={s.formNote} id="contact-form-note">Your message is saved securely for the MZ Property team to review. This form does not send an email.</p>
      <p
        className={`${s.formFeedback} ${feedback?.kind === 'success' ? s.formSuccess : feedback ? s.formFailure : ''}`}
        id="contact-form-feedback"
        role={feedback?.kind === 'error' ? 'alert' : 'status'}
        aria-live="polite"
      >
        {feedback?.message || ''}
      </p>
    </form>
  )
}
