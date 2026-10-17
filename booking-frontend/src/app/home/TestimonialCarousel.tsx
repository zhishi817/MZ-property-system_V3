"use client"

import { useEffect, useRef } from 'react'
import { decideTestimonialSwipe } from '../../lib/carouselMath'
import s from './home.module.css'

const testimonials = [
  {
    title: '“Amazing Home, Amazing Team”',
    body: 'What an amazing place to stay! Centrally located and within walking distance of everything I required! Ming was a wonderful host! Very helpful! I can’t wait to come back and stay again!',
    author: 'Jacinda',
  },
  {
    title: '“Surpassed All My Expectations!”',
    body: 'Very convenient, great amenities and communication from the host. The building is well maintained and would return anytime visiting Melbourne.',
    author: 'Justin',
  },
  {
    title: '“I Couldn’t Be Happier with the House”',
    body: 'We stayed at 3 Airbnbs while in Melbourne and this was the best by far. Close to multiple tram stops, excellent accommodation with wonderful views — super responsive host and very good amenities in the house.',
    author: 'Ben',
  },
]

type Gesture = {
  pointerId: number
  startX: number
  startY: number
  lastX: number
  lastY: number
  lastEventAt: number
  axis: 'horizontal' | 'vertical' | null
  previewDirection: number
  width: number
  samples: Array<{ x: number; time: number }>
  captureWatchdog: number | null
}

type SettleState = {
  token: number
  commit: boolean
  targetIndex: number
  announceChange: boolean
  timeout: number
  onTransitionEnd: (event: TransitionEvent) => void
}

export default function TestimonialCarousel() {
  const rootRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const viewport = root.querySelector<HTMLElement>('[data-testimonial-viewport]')!
    const slides = [...root.querySelectorAll<HTMLElement>('[data-testimonial-slide]')]
    const dots = [...root.querySelectorAll<HTMLButtonElement>('[data-slide]')]
    const dotsGroup = root.querySelector<HTMLElement>('[data-dots]')
    const pauseButton = root.querySelector<HTMLButtonElement>('[data-pause]')
    const status = root.querySelector<HTMLElement>('[data-carousel-status]')
    const live = root.querySelector<HTMLElement>('[data-carousel-live]')
    const previous = root.querySelector<HTMLButtonElement>('[data-prev]')
    const next = root.querySelector<HTMLButtonElement>('[data-next]')
    if (!viewport || !dotsGroup || !pauseButton || !status || !live || !previous || !next) return

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let current = 0
    let userPaused = reducedMotion.matches
    let interactionPaused = false
    let gesturePaused = false
    let timer = 0
    let gesture: Gesture | null = null
    let gestureBlocked = false
    let settle: SettleState | null = null
    let settleSequence = 0
    const activePointers = new Set<number>()

    const normalize = (index: number) => (index + slides.length) % slides.length
    const updateDots = (index: number) => {
      dots.forEach((dot, dotIndex) => {
        dot.classList.toggle(s.active, dotIndex === index)
        dot.toggleAttribute('aria-current', dotIndex === index)
      })
      dotsGroup.dataset.position = `${index + 1} / ${slides.length}`
    }
    const positionSlides = (center = current) => {
      slides.forEach((slide, slideIndex) => {
        const forwardDistance = (slideIndex - center + slides.length) % slides.length
        const position = forwardDistance === 0 ? 0 : forwardDistance <= slides.length / 2 ? 1 : -1
        slide.style.setProperty('--testimonial-slide-offset', `${position * 100}%`)
      })
    }
    const clearPreview = () => {
      slides.forEach((slide) => slide.classList.remove(s.preview))
      viewport.style.setProperty('--testimonial-preview-opacity', '0')
    }
    const showPreview = (direction: number, opacity = 0) => {
      slides.forEach((slide) => slide.classList.remove(s.preview))
      if (!direction) return
      slides[normalize(current + direction)].classList.add(s.preview)
      viewport.style.setProperty('--testimonial-preview-opacity', String(opacity))
    }
    const announce = () => {
      live.textContent = ''
      window.setTimeout(() => {
        live.textContent = `Showing testimonial ${current + 1} of ${slides.length}, by ${testimonials[current].author}.`
      }, 20)
    }
    const render = (index: number, shouldAnnounce = false) => {
      current = normalize(index)
      positionSlides()
      slides.forEach((slide, slideIndex) => {
        const active = slideIndex === current
        slide.classList.toggle(s.active, active)
        slide.setAttribute('aria-hidden', String(!active))
        slide.toggleAttribute('inert', !active)
      })
      updateDots(current)
      root.dataset.activeIndex = String(current)
      if (shouldAnnounce) announce()
    }
    const updatePauseUI = () => {
      pauseButton.classList.toggle(s.paused, userPaused)
      pauseButton.setAttribute('aria-pressed', String(userPaused))
      pauseButton.setAttribute('aria-label', userPaused ? 'Resume testimonial rotation' : 'Pause testimonial rotation')
      status.textContent = reducedMotion.matches
        ? 'Automatic rotation disabled by reduced-motion preference.'
        : userPaused
          ? 'Automatic rotation paused.'
          : 'Rotating automatically. Hover or focus to pause.'
    }
    function restart() {
      window.clearInterval(timer)
      if (userPaused || interactionPaused || gesturePaused || reducedMotion.matches) return
      timer = window.setInterval(() => goTo(current + 1, false, 1), 6500)
    }
    function clearSettleListeners(state: SettleState | null) {
      if (!state) return
      window.clearTimeout(state.timeout)
      viewport.removeEventListener('transitionend', state.onTransitionEnd)
    }
    function finishSettle(token = settle?.token) {
      if (!settle || settle.token !== token) return
      const completed = settle
      clearSettleListeners(completed)
      settle = null
      viewport.classList.add(s.resetting)
      viewport.classList.remove(s.dragging, s.settling)
      viewport.style.setProperty('--testimonial-drag-x', '0px')
      delete viewport.dataset.commit
      clearPreview()
      if (completed.commit) render(completed.targetIndex, completed.announceChange)
      else updateDots(current)
      void viewport.offsetWidth
      viewport.classList.remove(s.resetting)
      gesture = null
      gesturePaused = gestureBlocked
      restart()
    }
    function resetTrack() {
      viewport.classList.add(s.resetting)
      viewport.classList.remove(s.dragging, s.settling)
      viewport.style.setProperty('--testimonial-drag-x', '0px')
      delete viewport.dataset.commit
      clearPreview()
      void viewport.offsetWidth
      viewport.classList.remove(s.resetting)
    }
    function startSettle(commit: boolean, direction: number, targetIndex = current, shouldAnnounce = false) {
      if (!direction) {
        resetTrack()
        gesturePaused = gestureBlocked
        restart()
        return
      }
      window.clearInterval(timer)
      gesture = null
      gesturePaused = true
      const target = normalize(targetIndex)
      const previewIndex = normalize(current + direction)
      if (!slides[previewIndex].classList.contains(s.preview)) {
        const dragAmount = Math.abs(parseFloat(viewport.style.getPropertyValue('--testimonial-drag-x')) || 0)
        showPreview(direction, Math.min(0.92, 0.12 + dragAmount / Math.max(1, viewport.clientWidth) * 1.45))
      }
      if (commit) {
        const previewOpacity = parseFloat(viewport.style.getPropertyValue('--testimonial-preview-opacity')) || 0
        showPreview(direction, previewOpacity)
        updateDots(target)
      }
      viewport.classList.remove(s.dragging)
      viewport.classList.add(s.settling)
      viewport.dataset.commit = String(commit)
      void viewport.offsetWidth
      const token = ++settleSequence
      const onTransitionEnd = (event: TransitionEvent) => {
        if (event.propertyName === 'transform') finishSettle(token)
      }
      settle = { token, commit, targetIndex: target, announceChange: shouldAnnounce, timeout: 0, onTransitionEnd }
      viewport.addEventListener('transitionend', onTransitionEnd)
      settle.timeout = window.setTimeout(() => finishSettle(token), 520)
      const destination = commit ? -direction * viewport.getBoundingClientRect().width : 0
      viewport.style.setProperty('--testimonial-drag-x', `${destination}px`)
      viewport.style.setProperty('--testimonial-preview-opacity', commit ? '1' : '0')
      if (reducedMotion.matches) finishSettle(token)
    }
    function goTo(index: number, shouldAnnounce = true, directionHint = 0) {
      if (settle) finishSettle(settle.token)
      const target = normalize(index)
      if (target === current) {
        updateDots(current)
        restart()
        return
      }
      const forwardDistance = (target - current + slides.length) % slides.length
      const direction = directionHint || (forwardDistance <= slides.length / 2 ? 1 : -1)
      if (reducedMotion.matches) {
        resetTrack()
        render(target, shouldAnnounce)
        gesturePaused = false
        restart()
        return
      }
      showPreview(direction, 0)
      startSettle(true, direction, target, shouldAnnounce)
    }
    function rebound() {
      const offset = parseFloat(viewport.style.getPropertyValue('--testimonial-drag-x')) || 0
      startSettle(false, offset < 0 ? 1 : offset > 0 ? -1 : 0)
    }
    function clearCaptureWatchdog() {
      if (!gesture?.captureWatchdog) return
      window.clearTimeout(gesture.captureWatchdog)
      gesture.captureWatchdog = null
    }
    function recordSample(pointerGesture: Gesture, x: number, time: number) {
      pointerGesture.samples.push({ x, time })
      pointerGesture.samples = pointerGesture.samples.filter((sample) => time - sample.time <= 180)
    }
    function velocity(pointerGesture: Gesture, finalX: number, finalTime: number) {
      const sample = [...pointerGesture.samples].reverse().find((candidate) => (
        finalTime - candidate.time >= 24 && Math.abs(finalX - candidate.x) >= 1
      )) || pointerGesture.samples.find((candidate) => Math.abs(finalX - candidate.x) >= 1)
      return sample ? (finalX - sample.x) / Math.max(1, finalTime - sample.time) : 0
    }
    function setDrag(deltaX: number) {
      if (!gesture) return
      const direction = deltaX < 0 ? 1 : -1
      const limit = gesture.width * 0.88
      const absolute = Math.abs(deltaX)
      const resisted = absolute <= limit ? absolute : limit + (absolute - limit) * 0.18
      const visualOffset = Math.sign(deltaX) * Math.min(gesture.width * 0.96, resisted)
      const opacity = Math.min(0.92, 0.12 + absolute / Math.max(1, gesture.width) * 1.45)
      if (gesture.previewDirection !== direction) {
        gesture.previewDirection = direction
        showPreview(direction, opacity)
      } else viewport.style.setProperty('--testimonial-preview-opacity', String(opacity))
      viewport.style.setProperty('--testimonial-drag-x', `${visualOffset}px`)
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' || event.button !== 0) return
      if (settle) finishSettle(settle.token)
      activePointers.add(event.pointerId)
      if (activePointers.size > 1 || gesture) {
        clearCaptureWatchdog()
        gestureBlocked = true
        gesture = null
        gesturePaused = true
        rebound()
        return
      }
      const time = performance.now()
      gesturePaused = true
      gesture = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        lastEventAt: time,
        axis: null,
        previewDirection: 0,
        width: viewport.getBoundingClientRect().width,
        samples: [{ x: event.clientX, time }],
        captureWatchdog: null,
      }
      window.clearInterval(timer)
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!gesture || gestureBlocked || event.pointerId !== gesture.pointerId) return
      clearCaptureWatchdog()
      const time = performance.now()
      gesture.lastX = event.clientX
      gesture.lastY = event.clientY
      gesture.lastEventAt = time
      recordSample(gesture, event.clientX, time)
      const deltaX = gesture.lastX - gesture.startX
      const deltaY = gesture.lastY - gesture.startY
      const absX = Math.abs(deltaX)
      const absY = Math.abs(deltaY)
      if (!gesture.axis && Math.max(absX, absY) >= 10) {
        if (absX > absY * 1.15) gesture.axis = 'horizontal'
        else if (absY > absX * 1.15) gesture.axis = 'vertical'
      }
      if (gesture.axis === 'vertical') {
        gesture = null
        gesturePaused = false
        resetTrack()
        restart()
        return
      }
      if (gesture.axis !== 'horizontal') return
      viewport.classList.add(s.dragging)
      setDrag(deltaX)
    }
    const onPointerUp = (event: PointerEvent) => {
      activePointers.delete(event.pointerId)
      if (gestureBlocked) {
        if (!activePointers.size) {
          gestureBlocked = false
          if (!settle) {
            gesturePaused = false
            resetTrack()
            restart()
          }
        }
        return
      }
      if (!gesture || event.pointerId !== gesture.pointerId) return
      clearCaptureWatchdog()
      const completed = gesture
      const time = performance.now()
      recordSample(completed, event.clientX, time)
      const deltaX = event.clientX - completed.startX
      const deltaY = event.clientY - completed.startY
      const decision = decideTestimonialSwipe({
        deltaX,
        deltaY,
        velocityX: velocity(completed, event.clientX, time),
        viewportWidth: completed.width,
        horizontalLocked: completed.axis === 'horizontal',
      })
      gesture = null
      if (decision.commit) startSettle(true, decision.direction, current + decision.direction, true)
      else rebound()
    }
    const onPointerCancel = (event: PointerEvent) => {
      activePointers.delete(event.pointerId)
      if (gesture && event.pointerId === gesture.pointerId) {
        clearCaptureWatchdog()
        gesture = null
        rebound()
      } else if (gestureBlocked && !activePointers.size) {
        gestureBlocked = false
        if (!settle) {
          gesturePaused = false
          resetTrack()
          restart()
        }
      }
    }
    const onLostCapture = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return
      clearCaptureWatchdog()
      const pointerId = event.pointerId
      const lastEventAt = gesture.lastEventAt
      gesture.captureWatchdog = window.setTimeout(() => {
        if (!gesture || gesture.pointerId !== pointerId || gesture.lastEventAt !== lastEventAt) return
        activePointers.delete(pointerId)
        gesture = null
        rebound()
      }, 120)
    }
    const abortGesture = () => {
      clearCaptureWatchdog()
      activePointers.clear()
      gestureBlocked = false
      if (settle) finishSettle(settle.token)
      else if (gesture) {
        gesture = null
        rebound()
      } else {
        gesturePaused = false
        resetTrack()
        restart()
      }
    }
    const onVisibility = () => { if (document.hidden) abortGesture() }
    const onMouseEnter = () => { interactionPaused = true; restart() }
    const onMouseLeave = () => { interactionPaused = false; restart() }
    const onFocusIn = () => { interactionPaused = true; restart() }
    const onFocusOut = (event: FocusEvent) => {
      if (!root.contains(event.relatedTarget as Node | null)) { interactionPaused = false; restart() }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') goTo(current - 1, true, -1)
      if (event.key === 'ArrowRight') goTo(current + 1, true, 1)
    }
    const onReducedMotion = (event: MediaQueryListEvent) => {
      if (event.matches) userPaused = true
      updatePauseUI()
      restart()
    }
    const onPause = () => {
      userPaused = !userPaused
      updatePauseUI()
      restart()
    }
    const onPrevious = () => goTo(current - 1, true, -1)
    const onNext = () => goTo(current + 1, true, 1)
    const dotHandlers = dots.map((dot, index) => {
      const handler = () => goTo(index, true)
      dot.addEventListener('click', handler)
      return handler
    })

    viewport.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    viewport.addEventListener('lostpointercapture', onLostCapture)
    window.addEventListener('blur', abortGesture)
    document.addEventListener('visibilitychange', onVisibility)
    root.addEventListener('mouseenter', onMouseEnter)
    root.addEventListener('mouseleave', onMouseLeave)
    root.addEventListener('focusin', onFocusIn)
    root.addEventListener('focusout', onFocusOut)
    root.addEventListener('keydown', onKeyDown)
    reducedMotion.addEventListener('change', onReducedMotion)
    pauseButton.addEventListener('click', onPause)
    previous.addEventListener('click', onPrevious)
    next.addEventListener('click', onNext)
    render(0)
    updatePauseUI()
    restart()

    return () => {
      window.clearInterval(timer)
      clearSettleListeners(settle)
      clearCaptureWatchdog()
      viewport.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      viewport.removeEventListener('lostpointercapture', onLostCapture)
      window.removeEventListener('blur', abortGesture)
      document.removeEventListener('visibilitychange', onVisibility)
      root.removeEventListener('mouseenter', onMouseEnter)
      root.removeEventListener('mouseleave', onMouseLeave)
      root.removeEventListener('focusin', onFocusIn)
      root.removeEventListener('focusout', onFocusOut)
      root.removeEventListener('keydown', onKeyDown)
      reducedMotion.removeEventListener('change', onReducedMotion)
      pauseButton.removeEventListener('click', onPause)
      previous.removeEventListener('click', onPrevious)
      next.removeEventListener('click', onNext)
      dots.forEach((dot, index) => dot.removeEventListener('click', dotHandlers[index]))
    }
  }, [])

  return (
    <section ref={rootRef} className={s.testimonials} id="testimonials" aria-labelledby="testimonials-title" tabIndex={0}>
      <div className={`${s.testimonialMedia} ${s.reveal}`} data-reveal>
        <img src="/homepage/testimonial.jpg" alt="Softly styled sofa and neutral cushions" />
      </div>
      <div className={`${s.testimonialPanel} ${s.reveal}`} data-reveal>
        <p className={s.eyebrow}>Guest notes</p>
        <h2 id="testimonials-title">What Clients Say</h2>
        <div className={s.testimonialCopy} data-testimonial-viewport>
          {testimonials.map((testimonial, index) => (
            <article
              className={`${s.testimonialSlide} ${index === 0 ? s.active : ''}`}
              data-testimonial-slide
              aria-hidden={index === 0 ? 'false' : 'true'}
              key={testimonial.author}
            >
              <blockquote>{testimonial.title}</blockquote>
              <p>{testimonial.body}</p>
              <cite>{testimonial.author}</cite>
              <div className={s.stars} aria-label="5 out of 5 stars">
                {Array.from({ length: 5 }, (_, star) => <img key={star} src="/homepage/icon-star.svg" alt="" />)}
              </div>
            </article>
          ))}
        </div>
        <div className={s.carouselFooter}>
          <div className={s.carouselDots} data-dots data-position="1 / 3" aria-label="Choose testimonial">
            {testimonials.map((testimonial, index) => (
              <button
                key={testimonial.author}
                className={`${s.dot} ${index === 0 ? s.active : ''}`}
                type="button"
                data-slide={index}
                aria-label={`Show testimonial ${index + 1}`}
                aria-current={index === 0 ? 'true' : undefined}
              />
            ))}
          </div>
          <div className={s.carouselControls}>
            <button className={`${s.iconButton} ${s.carouselButton}`} type="button" data-prev aria-label="Previous testimonial"><img src="/homepage/icon-arrow-left.svg" alt="" /></button>
            <button className={`${s.iconButton} ${s.carouselButton} ${s.pauseButton}`} type="button" data-pause aria-label="Pause testimonial rotation" aria-pressed="false">
              <img className={s.pauseIcon} src="/homepage/icon-pause.svg" alt="" />
              <img className={s.playIcon} src="/homepage/icon-play.svg" alt="" />
            </button>
            <button className={`${s.iconButton} ${s.carouselButton}`} type="button" data-next aria-label="Next testimonial"><img src="/homepage/icon-arrow-right.svg" alt="" /></button>
          </div>
        </div>
        <p className={s.carouselStatus} data-carousel-status />
        <div className={s.srOnly} aria-live="polite" data-carousel-live />
      </div>
    </section>
  )
}
