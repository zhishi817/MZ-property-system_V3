"use client"

import { Button, List, Modal, Select, Space, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { getJSON } from '../lib/api'
import {
  hidePropertyPayableVendor,
  loadHiddenPropertyPayableVendorKeys,
  PROPERTY_PAYABLE_HIDDEN_VENDOR_STORAGE_KEY,
  propertyPayableVendorKey,
  restorePropertyPayableVendor,
  saveHiddenPropertyPayableVendorKeys,
  visiblePropertyPayableVendorOptions,
} from '../lib/propertyPayableVendorPreferences'

type VendorOption = { value: string; label?: string; usage_count?: number }

let vendorOptionsCache: VendorOption[] | null = null
const vendorOptionListeners = new Set<(options: VendorOption[]) => void>()
let hiddenVendorKeysCache: string[] | null = null
const hiddenVendorListeners = new Set<(keys: string[]) => void>()

function publishVendorOptions(options: VendorOption[]) {
  vendorOptionsCache = options
  for (const listener of vendorOptionListeners) listener(options)
}

function publishHiddenVendorKeys(keys: string[]) {
  hiddenVendorKeysCache = keys
  for (const listener of hiddenVendorListeners) listener(keys)
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
  const [managerOpen, setManagerOpen] = useState(false)
  const [hiddenKeys, setHiddenKeys] = useState<string[]>(hiddenVendorKeysCache || [])

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

  useEffect(() => {
    const load = () => publishHiddenVendorKeys(loadHiddenPropertyPayableVendorKeys(window.localStorage))
    hiddenVendorListeners.add(setHiddenKeys)
    if (hiddenVendorKeysCache !== null) setHiddenKeys(hiddenVendorKeysCache)
    else load()
    const handleStorage = (event: StorageEvent) => {
      if (event.key === PROPERTY_PAYABLE_HIDDEN_VENDOR_STORAGE_KEY) load()
    }
    window.addEventListener('storage', handleStorage)
    return () => {
      hiddenVendorListeners.delete(setHiddenKeys)
      window.removeEventListener('storage', handleStorage)
    }
  }, [])

  const allOptions = useMemo(() => {
    const map = new Map<string, VendorOption>()
    for (const item of options) {
      const value = String(item?.value || '').trim()
      if (!value) continue
      map.set(value.toLowerCase(), { value, label: String(item?.label || value) })
    }
    return Array.from(map.values())
  }, [options])
  const mergedOptions = useMemo(() => visiblePropertyPayableVendorOptions(allOptions, hiddenKeys), [allOptions, hiddenKeys])
  const hiddenOptions = useMemo(() => {
    const hidden = new Set(hiddenKeys)
    return allOptions.filter((option) => hidden.has(propertyPayableVendorKey(option.value)))
  }, [allOptions, hiddenKeys])

  function updateHiddenKeys(next: string[]) {
    const saved = saveHiddenPropertyPayableVendorKeys(window.localStorage, next)
    publishHiddenVendorKeys(saved)
  }

  function commitCustomValue(raw?: string) {
    const value = String(raw || '').trim()
    if (!value) return
    props.onChange?.(value)
    setSearch('')
  }

  return (
    <>
      <Space.Compact style={{ width: '100%' }}>
        <Select
          showSearch
          allowClear
          value={props.value || undefined}
          placeholder={props.placeholder || '请选择或输入收费公司/事项'}
          options={mergedOptions}
          optionFilterProp="label"
          popupMatchSelectWidth
          style={{ flex: 1 }}
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
        <Button onClick={() => setManagerOpen(true)}>管理下拉选项</Button>
      </Space.Compact>
      <Modal open={managerOpen} title="管理收费公司建议项" footer={null} onCancel={() => setManagerOpen(false)}>
        <Typography.Paragraph type="secondary">
          仅隐藏当前浏览器中的建议项，不会删除或修改模板、账单、历史及已保存值，也不会同步到其他浏览器或用户。
        </Typography.Paragraph>
        <List
          size="small"
          locale={{ emptyText: '暂无可管理的建议项' }}
          dataSource={allOptions}
          renderItem={(option) => {
            const hidden = hiddenKeys.includes(propertyPayableVendorKey(option.value))
            return <List.Item actions={[hidden
              ? <Button key="restore" type="link" onClick={() => updateHiddenKeys(restorePropertyPayableVendor(hiddenKeys, option.value))}>恢复</Button>
              : <Button key="hide" type="link" onClick={() => updateHiddenKeys(hidePropertyPayableVendor(hiddenKeys, option.value))}>移除建议</Button>
            ]}>
              <Space><span>{option.label || option.value}</span>{hidden ? <Typography.Text type="secondary">已隐藏</Typography.Text> : null}</Space>
            </List.Item>
          }}
        />
        {hiddenOptions.length ? <Typography.Text type="secondary">已隐藏 {hiddenOptions.length} 项，可随时恢复。</Typography.Text> : null}
      </Modal>
    </>
  )
}
