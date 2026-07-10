"use client"

import { Select } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { getJSON } from '../lib/api'

type VendorOption = { value: string; label?: string; usage_count?: number }

let vendorOptionsCache: VendorOption[] | null = null
const vendorOptionListeners = new Set<(options: VendorOption[]) => void>()

function publishVendorOptions(options: VendorOption[]) {
  vendorOptionsCache = options
  for (const listener of vendorOptionListeners) listener(options)
}

export function rememberPropertyPayableVendors(raw: any) {
  const values = (Array.isArray(raw) ? raw : [raw])
    .map((item) => String(typeof item === 'string' ? item : item?.vendor || '').trim())
    .filter(Boolean)
  if (!values.length) return

  const map = new Map<string, VendorOption>()
  for (const item of vendorOptionsCache || []) {
    const value = String(item?.value || '').trim()
    if (!value) continue
    map.set(value.toLowerCase(), { value, label: String(item?.label || value) })
  }
  for (const value of values) {
    const key = value.toLowerCase()
    if (!map.has(key)) map.set(key, { value, label: value })
  }
  publishVendorOptions(Array.from(map.values()))
}

export default function PropertyPayableVendorInput(props: {
  value?: string
  onChange?: (value: string) => void
  placeholder?: string
}) {
  const [options, setOptions] = useState<VendorOption[]>(vendorOptionsCache || [])
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (vendorOptionsCache) return
    let active = true
    void getJSON<VendorOption[]>('/recurring/property-payables/vendors')
      .then((rows) => {
        if (!active) return
        const next = Array.isArray(rows)
          ? rows
              .map((item) => {
                const value = String(item?.value || item?.label || '').trim()
                if (!value) return null
                return { value, label: String(item?.label || value) }
              })
              .filter(Boolean) as VendorOption[]
          : []
        vendorOptionsCache = next
        publishVendorOptions(next)
      })
      .catch(() => {})
    return () => { active = false }
  }, [])

  useEffect(() => {
    vendorOptionListeners.add(setOptions)
    return () => { vendorOptionListeners.delete(setOptions) }
  }, [])

  const mergedOptions = useMemo(() => {
    const map = new Map<string, VendorOption>()
    for (const item of options) {
      const value = String(item?.value || '').trim()
      if (!value) continue
      map.set(value.toLowerCase(), { value, label: String(item?.label || value) })
    }
    return Array.from(map.values())
  }, [options])

  function commitCustomValue(raw?: string) {
    const value = String(raw || '').trim()
    if (!value) return
    props.onChange?.(value)
    setSearch('')
  }

  return (
    <Select
      showSearch
      allowClear
      value={props.value || undefined}
      placeholder={props.placeholder || '请选择或输入收费公司/事项'}
      options={mergedOptions}
      optionFilterProp="label"
      popupMatchSelectWidth
      onChange={(value) => props.onChange?.(String(value || ''))}
      onSearch={setSearch}
      onBlur={() => commitCustomValue(search)}
      onInputKeyDown={(event) => {
        if (event.key !== 'Enter') return
        if (!search.trim()) return
        event.preventDefault()
        commitCustomValue(search)
      }}
      notFoundContent={search.trim() ? '保存后会加入备选项' : '暂无收费公司/事项'}
    />
  )
}
