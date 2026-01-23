"use client"
import { useEffect, useState } from 'react'

export default function ClientOnly({ children, placeholder }: { children: React.ReactNode; placeholder?: React.ReactNode }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  if (!mounted) return <>{placeholder ?? <div data-client-only></div>}</>
  return <>{children}</>
}
