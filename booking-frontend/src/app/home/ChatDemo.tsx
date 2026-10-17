"use client"

import { useEffect, useRef, useState } from 'react'
import s from './home.module.css'

export default function ChatDemo() {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  function close() {
    setOpen(false)
    window.requestAnimationFrame(() => triggerRef.current?.focus())
  }

  return (
    <div className={s.chatDemo}>
      <button ref={triggerRef} className={`${s.button} ${s.chatButton}`} type="button" onClick={() => setOpen(true)}>
        <img src="/homepage/icon-chat.svg" alt="" />
        <span>Let&apos;s Chat!</span>
      </button>
      <dialog
        ref={dialogRef}
        className={s.chatDialog}
        aria-labelledby="chat-demo-title"
        onCancel={(event) => { event.preventDefault(); close() }}
        onClose={() => setOpen(false)}
        onClick={(event) => { if (event.target === dialogRef.current) close() }}
      >
        <div className={s.chatDialogCard}>
          <button className={`${s.iconButton} ${s.chatClose}`} type="button" aria-label="Close chat demo" onClick={close}>
            <img src="/homepage/icon-close.svg" alt="" />
          </button>
          <p className={s.eyebrow}>Chat preview</p>
          <h2 id="chat-demo-title">We&apos;d love to help.</h2>
          <p>This is a visual demo only and is not connected to a live support service. Please use the contact form so the MZ Property team can review your message.</p>
          <button className={s.button} type="button" onClick={close}>Return to the form</button>
        </div>
      </dialog>
    </div>
  )
}
