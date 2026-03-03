"use client"
import dayjs from 'dayjs'
import { useEffect, useRef, useState } from 'react'
import { apiList, getJSON } from '../../../lib/api'
import MonthlyStatementView from '../../../components/MonthlyStatement'
import { buildStatementTxs } from '../../../lib/statementTx'

type Order = { id: string; property_id?: string; checkin?: string; checkout?: string; price?: number; nights?: number }
type Landlord = { id: string; name: string; management_fee_rate?: number; property_ids?: string[] }

export default function PublicMonthlyStatementPrintPage() {
  const [month, setMonth] = useState<any>(dayjs())
  const [propertyId, setPropertyId] = useState<string | undefined>(undefined)
  const [orders, setOrders] = useState<Order[]>([])
  const [txs, setTxs] = useState<any[]>([])
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string }[]>([])
  const [landlords, setLandlords] = useState<Landlord[]>([])
  const [showChinese, setShowChinese] = useState<boolean>(true)
  const [pdfMode, setPdfMode] = useState<boolean>(true)
  const [sections, setSections] = useState<string[]>(['all'])
  const [includeJobPhotos, setIncludeJobPhotos] = useState<boolean>(true)
  const [photosMode, setPhotosMode] = useState<'full' | 'compressed' | 'thumbnail' | 'off'>('full')
  const [photoW, setPhotoW] = useState<number | undefined>(undefined)
  const [photoQ, setPhotoQ] = useState<number | undefined>(undefined)
  const ref = useRef<HTMLDivElement>(null)
  const inited = useRef<boolean>(false)

  useEffect(() => {
    if (inited.current) return
    inited.current = true
    try {
      const qs = typeof window !== 'undefined' ? window.location.search : ''
      const sp = new URLSearchParams(qs || '')
      const m = sp.get('month') || ''
      const pid = sp.get('pid') || ''
      const sc = sp.get('showChinese')
      const pdf = sp.get('pdf')
      const sec = sp.get('sections')
      const includePhotos = sp.get('includePhotos')
      const photosMode = sp.get('photos')
      const photoW = sp.get('photo_w') || sp.get('photoW')
      const photoQ = sp.get('photo_q') || sp.get('photoQ')
      if (sc === '0' || sc === '1') setShowChinese(sc === '1')
      if (pdf === '0' || pdf === '1') setPdfMode(pdf === '1')
      if (m) setMonth(dayjs(m))
      if (pid) setPropertyId(pid)
      if (sec) {
        const arr = sec.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        if (arr.length) setSections(arr)
      }
      if (includePhotos === '0' || includePhotos === '1') {
        setIncludeJobPhotos(includePhotos === '1')
      } else if (photosMode) {
        setIncludeJobPhotos(String(photosMode).toLowerCase() !== 'off')
      }
      if (photosMode) {
        const pm = String(photosMode).toLowerCase()
        if (pm === 'off') setPhotosMode('off')
        else if (pm === 'compressed') setPhotosMode('compressed')
        else if (pm === 'thumbnail') setPhotosMode('thumbnail')
        else setPhotosMode('full')
      }
      if (photoW) {
        const n = Number(photoW)
        if (Number.isFinite(n) && n > 0) setPhotoW(n)
      }
      if (photoQ) {
        const n = Number(photoQ)
        if (Number.isFinite(n) && n > 0) setPhotoQ(n)
      }
    } catch {}
  }, [])

  useEffect(() => { getJSON<any>('/properties').then(j => setProperties(j || [])).catch(() => setProperties([])) }, [])
  useEffect(() => {
    getJSON<Order[]>('/orders').then(setOrders).catch(() => setOrders([]))
    ;(async () => {
      try {
        const fin: any[] = await getJSON<any[]>('/finance')
        const pexp: any[] = await apiList<any[]>('property_expenses')
        const recurs: any[] = await apiList<any[]>('recurring_payments')
        const built = buildStatementTxs(fin, pexp, { properties, recurring_payments: recurs, excludeOrphanFixedSnapshots: false })
        setTxs(built.txs as any)
      } catch { setTxs([]) }
    })()
    getJSON<Landlord[]>('/landlords').then(setLandlords).catch(() => setLandlords([]))
  }, [properties])

  if (!propertyId) return <div />

  return (
    <MonthlyStatementView
      ref={ref}
      month={month.format('YYYY-MM')}
      propertyId={propertyId}
      orders={orders as any}
      txs={txs as any}
      properties={properties as any}
      landlords={landlords as any}
      showChinese={showChinese}
      showInvoices={false}
      sections={sections}
      includeJobPhotos={includeJobPhotos}
      photosMode={photosMode}
      photoW={photoW}
      photoQ={photoQ}
      mode="pdf"
      pdfMode={pdfMode}
      renderEngine="print"
    />
  )
}
