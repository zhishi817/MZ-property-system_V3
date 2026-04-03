"use client"
import dayjs from 'dayjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import { apiList, getJSON } from '../../../lib/api'
import MonthlyStatementView from '../../../components/MonthlyStatement'
import { buildStatementTxs } from '../../../lib/statementTx'
import { computeMonthlyStatementBalanceDebug } from '../../../lib/statementBalances'
import { resolveExcludeOrphanFixedSnapshotsParam } from '../../../lib/monthlyStatementPrint'

type Order = { id: string; property_id?: string; checkin?: string; checkout?: string; price?: number; nights?: number }
type Landlord = { id: string; name: string; management_fee_rate?: number; property_ids?: string[] }

export default function PublicMonthlyStatementPrintPage() {
  const [month, setMonth] = useState<any>(dayjs())
  const [propertyId, setPropertyId] = useState<string | undefined>(undefined)
  const [orders, setOrders] = useState<Order[]>([])
  const [txs, setTxs] = useState<any[]>([])
  const [properties, setProperties] = useState<{ id: string; code?: string; address?: string }[]>([])
  const [landlords, setLandlords] = useState<Landlord[]>([])
  const [ordersLoaded, setOrdersLoaded] = useState<boolean>(false)
  const [txsLoaded, setTxsLoaded] = useState<boolean>(false)
  const [propertiesLoaded, setPropertiesLoaded] = useState<boolean>(false)
  const [landlordsLoaded, setLandlordsLoaded] = useState<boolean>(false)
  const [showChinese, setShowChinese] = useState<boolean>(true)
  const [pdfMode, setPdfMode] = useState<boolean>(true)
  const [sections, setSections] = useState<string[]>(['all'])
  const [includeJobPhotos, setIncludeJobPhotos] = useState<boolean>(true)
  const [photosMode, setPhotosMode] = useState<'full' | 'compressed' | 'thumbnail' | 'off'>('full')
  const [photoW, setPhotoW] = useState<number | undefined>(undefined)
  const [photoQ, setPhotoQ] = useState<number | undefined>(undefined)
  const [excludeOrphanFixedSnapshots, setExcludeOrphanFixedSnapshots] = useState<boolean>(true)
  const [rawFin, setRawFin] = useState<any[]>([])
  const [rawPexp, setRawPexp] = useState<any[]>([])
  const [rawRecurs, setRawRecurs] = useState<any[]>([])
  const [rawTxLoaded, setRawTxLoaded] = useState<boolean>(false)
  const [orphanCount, setOrphanCount] = useState<number>(0)
  const ref = useRef<HTMLDivElement>(null)
  const inited = useRef<boolean>(false)
  const fetchTimeoutMs = 25000

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
      const excludeOrphans = sp.get('exclude_orphan_fixed') || sp.get('excludeOrphanFixedSnapshots')
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
      setExcludeOrphanFixedSnapshots(resolveExcludeOrphanFixedSnapshotsParam(excludeOrphans))
    } catch {}
  }, [])

  useEffect(() => {
    setPropertiesLoaded(false)
    getJSON<any>('/properties', { timeoutMs: fetchTimeoutMs })
      .then(j => setProperties(j || []))
      .catch(() => setProperties([]))
      .finally(() => setPropertiesLoaded(true))
  }, [])
  useEffect(() => {
    setOrdersLoaded(false)
    setLandlordsLoaded(false)
    ;(async () => {
      const pid = String(propertyId || '').trim()
      const mk = month?.format ? String(month.format('YYYY-MM') || '').trim() : ''
      if (!pid || !/^\d{4}-\d{2}$/.test(mk)) {
        setOrders([])
        setOrdersLoaded(true)
        return
      }
      try {
        const qs = new URLSearchParams({ month: mk, property_id: pid }).toString()
        const resp = await getJSON<any>(`/finance/rent-segments?${qs}`, { timeoutMs: fetchTimeoutMs })
        const segs = Array.isArray(resp?.segments) ? resp.segments : []
        setOrders(segs)
      } catch {
        setOrders([])
      } finally {
        setOrdersLoaded(true)
      }
    })()
    getJSON<Landlord[]>('/landlords', { timeoutMs: fetchTimeoutMs })
      .then(setLandlords)
      .catch(() => setLandlords([]))
      .finally(() => setLandlordsLoaded(true))
  }, [propertyId, month])

  useEffect(() => {
    setRawTxLoaded(false)
    ;(async () => {
      try {
        const fin: any[] = await getJSON<any[]>('/finance', { timeoutMs: fetchTimeoutMs })
        const pexp: any[] = await apiList<any[]>('property_expenses', undefined, { timeoutMs: fetchTimeoutMs })
        const recurs: any[] = await apiList<any[]>('recurring_payments', undefined, { timeoutMs: fetchTimeoutMs })
        setRawFin(Array.isArray(fin) ? fin : [])
        setRawPexp(Array.isArray(pexp) ? pexp : [])
        setRawRecurs(Array.isArray(recurs) ? recurs : [])
      } catch {
        setRawFin([])
        setRawPexp([])
        setRawRecurs([])
      } finally {
        setRawTxLoaded(true)
      }
    })()
  }, [])

  useEffect(() => {
    if (!propertiesLoaded || !rawTxLoaded) {
      setTxs([])
      setTxsLoaded(false)
      setOrphanCount(0)
      return
    }
    const built = buildStatementTxs(rawFin, rawPexp, {
      properties,
      recurring_payments: rawRecurs,
      excludeOrphanFixedSnapshots,
    })
    setTxs(built.txs as any)
    setOrphanCount(Number(built.orphanCount || 0))
    setTxsLoaded(true)
  }, [propertiesLoaded, rawTxLoaded, properties, rawFin, rawPexp, rawRecurs, excludeOrphanFixedSnapshots])

  const balanceDebug = useMemo(() => {
    if (!propertyId || !/^\d{4}-\d{2}$/.test(String(month?.format?.('YYYY-MM') || ''))) return null
    if (!ordersLoaded || !txsLoaded || !propertiesLoaded || !landlordsLoaded) return null
    const property = properties.find(p => String(p.id) === String(propertyId))
    const landlord = landlords.find(l => (l.property_ids || []).includes(propertyId || ''))
    return computeMonthlyStatementBalanceDebug({
      month: month.format('YYYY-MM'),
      propertyId,
      propertyCode: property?.code,
      orders,
      txs,
      managementFeeRate: landlord?.management_fee_rate,
    })
  }, [propertyId, month, ordersLoaded, txsLoaded, propertiesLoaded, landlordsLoaded, properties, landlords, orders, txs])

  useEffect(() => {
    if (!balanceDebug || !propertyId) return
    console.info('[monthly-statement-print] carry diagnostics', {
      month: month.format('YYYY-MM'),
      propertyId,
      excludeOrphanFixedSnapshots,
      orphanCount,
      summary: balanceDebug.summary,
      target: balanceDebug.target,
    })
  }, [balanceDebug, propertyId, month, excludeOrphanFixedSnapshots, orphanCount])

  if (!propertyId) return <div />

  return (
    <MonthlyStatementView
      ref={ref}
      month={month.format('YYYY-MM')}
      propertyId={propertyId}
      orders={orders as any}
      orderSegments={orders as any}
      txs={txs as any}
      properties={properties as any}
      landlords={landlords as any}
      ordersLoaded={ordersLoaded}
      txsLoaded={txsLoaded}
      propertiesLoaded={propertiesLoaded}
      landlordsLoaded={landlordsLoaded}
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
