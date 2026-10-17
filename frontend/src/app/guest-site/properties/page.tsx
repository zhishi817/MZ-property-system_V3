"use client"

import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Collapse,
  Drawer,
  Form,
  Input,
  InputNumber,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd'
import type { UploadProps } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import TableRowActions from '../../../components/TableRowActions'
import { API_BASE, authHeaders, getJSON, patchJSON, postJSON } from '../../../lib/api'
import { hasPerm, preloadRolePerms } from '../../../lib/auth'
import {
  formatLineList,
  parseLineList,
  type GuestSiteAmenityCatalog,
  type GuestSiteAmenitySelection,
  type GuestSiteAmenityStatus,
  type GuestSiteAmenityTemplate,
  type GuestSiteAmenityTemplateList,
  type GuestSiteProperty,
} from '../../../lib/guestSite'
import {
  SAFE_COPY_FIELDS,
  STANDARD_CHECKIN_TIME,
  STANDARD_CHECKOUT_TIME,
  addCustomAmenity,
  amenityTemplateCandidatesFromKeys,
  buildingFacilityCandidateKeys,
  clientPublishReadiness,
  companyDefaultAmenityConflicts,
  copySafePropertyFields,
  canonicalGuestSiteTime,
  guestSiteTimeForEditor,
  guestSiteTimeForStorage,
  guestSiteTimeOptions,
  isCompanyDefaultAmenityKey,
  isReasonableEnglishLabel,
  mergeAmenityCandidates,
  mergeAmenitySelectionCandidates,
  pendingSelectionsFromTemplate,
  selectionWithStatus,
  type SafeCopyField,
} from '../../../lib/guestSitePropertyEditor'
import { buildGuestSiteDraftPreview } from '../../../lib/guestSitePropertyPreview'
import { STAY_POLICY_META, STAY_POLICY_SECTIONS, type PropertyStayPolicyOverview, type StayPolicySection } from '../../../lib/guestSiteStayPolicy'
import PropertyPolicyDrawer from './PropertyPolicyDrawer'
import styles from './page.module.css'

type PropertyEditor = GuestSiteProperty & {
  gallery_urls_text?: string
  feature_tags_text?: string
  house_rules_text?: string
  booking_highlights_text?: string
  amenity_selections?: GuestSiteAmenitySelection[]
  public_capacity_override?: number | null
}

const BOOKING_SITE_BASE =
  process.env.NEXT_PUBLIC_BOOKING_SITE_URL ||
  process.env.NEXT_PUBLIC_BOOKING_FRONTEND_URL ||
  'http://localhost:3004'

const BOOKING_SITE_ORIGIN = (() => {
  try { return new URL(BOOKING_SITE_BASE).origin } catch { return '' }
})()

function editorValues(row: GuestSiteProperty): PropertyEditor {
  return {
    ...row,
    gallery_urls_text: formatLineList(row.gallery_urls),
    feature_tags_text: formatLineList(row.feature_tags),
    house_rules_text: formatLineList(row.house_rules),
    booking_highlights_text: formatLineList(row.booking_highlights),
    amenity_selections: Array.isArray(row.amenity_selections) ? row.amenity_selections.map((item) => ({ ...item })) : [],
    checkin_time: guestSiteTimeForEditor(row.checkin_time, STANDARD_CHECKIN_TIME),
    checkout_time: guestSiteTimeForEditor(row.checkout_time, STANDARD_CHECKOUT_TIME),
  }
}

export default function Page() {
  const [data, setData] = useState<GuestSiteProperty[]>([])
  const [catalog, setCatalog] = useState<GuestSiteAmenityCatalog | null>(null)
  const [amenityTemplates, setAmenityTemplates] = useState<GuestSiteAmenityTemplate[]>([])
  const [templateStoreReady, setTemplateStoreReady] = useState<boolean | null>(null)
  const [templateEditorId, setTemplateEditorId] = useState('')
  const [templateName, setTemplateName] = useState('')
  const [templateScope, setTemplateScope] = useState<'company' | 'building'>('company')
  const [templateCandidateKeys, setTemplateCandidateKeys] = useState<string[]>([])
  const [templateSaving, setTemplateSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [actionRowId, setActionRowId] = useState('')
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<GuestSiteProperty | null>(null)
  const [publishIntent, setPublishIntent] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewValues, setPreviewValues] = useState<PropertyEditor | null>(null)
  const [previewNonce, setPreviewNonce] = useState('')
  const [policyProperty, setPolicyProperty] = useState<GuestSiteProperty | null>(null)
  const [selectedPolicyIds, setSelectedPolicyIds] = useState<React.Key[]>([])
  const [bulkPolicySection, setBulkPolicySection] = useState<StayPolicySection>('house_rules')
  const [bulkFollowing, setBulkFollowing] = useState(false)
  const [amenitySearch, setAmenitySearch] = useState('')
  const [copySourceId, setCopySourceId] = useState('')
  const [copyFields, setCopyFields] = useState<SafeCopyField[]>(SAFE_COPY_FIELDS.map((item) => item.key))
  const [customAmenityLabel, setCustomAmenityLabel] = useState('')
  const [customAmenityCategory, setCustomAmenityCategory] = useState('Other')
  const [form] = Form.useForm<PropertyEditor>()
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null)
  const { message, modal } = App.useApp()
  const [permissions, setPermissions] = useState({ canWriteProperties: false, canPublishPolicies: false })
  const canWriteProperties = permissions.canWriteProperties
  const canPublishPolicies = permissions.canPublishPolicies
  const watchedGalleryUrlsText = Form.useWatch('gallery_urls_text', form)
  const watchedHeroImageUrl = Form.useWatch('hero_image_url', form)
  const watchedAmenitySelectionsValue = Form.useWatch('amenity_selections', { form, preserve: true })
  const watchedCheckinTime = Form.useWatch('checkin_time', { form, preserve: true })
  const watchedCheckoutTime = Form.useWatch('checkout_time', { form, preserve: true })
  const watchedAmenitySelections = useMemo(
    () => Array.isArray(watchedAmenitySelectionsValue) ? watchedAmenitySelectionsValue : [],
    [watchedAmenitySelectionsValue],
  )
  const watchedValues = Form.useWatch([], form) || {}
  const currentGallery = useMemo(() => parseLineList(watchedGalleryUrlsText || ''), [watchedGalleryUrlsText])

  async function load() {
    setLoading(true)
    try {
      const [rows, amenityCatalog] = await Promise.all([
        getJSON<GuestSiteProperty[]>('/cms/guest-site/properties').catch(() => []),
        getJSON<GuestSiteAmenityCatalog>('/cms/guest-site/amenity-catalog').catch(() => null),
      ])
      const list = Array.isArray(rows) ? rows : []
      setData(
        [...list].sort((a, b) => {
          const sortGap = Number(a.sort_order ?? 99999) - Number(b.sort_order ?? 99999)
          if (sortGap) return sortGap
          const regionA = String(a.public_region_label || a.region || '未分区')
          const regionB = String(b.public_region_label || b.region || '未分区')
          if (regionA !== regionB) return regionA.localeCompare(regionB)
          return String(a.code || a.address || '').localeCompare(String(b.code || b.address || ''))
        }),
      )
      setCatalog(amenityCatalog)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    let active = true
    preloadRolePerms().catch(() => {}).finally(() => {
      if (active) setPermissions({
        canWriteProperties: hasPerm('guest_site_properties.write'),
        canPublishPolicies: hasPerm('guest_site_policies.publish'),
      })
    })
    return () => { active = false }
  }, [])

  async function loadAmenityTemplates(row: GuestSiteProperty) {
    try {
      const query = new URLSearchParams({ building_name: String(row.building_name || '').trim(), include_inactive: 'true' })
      const result = await getJSON<GuestSiteAmenityTemplateList>(`/cms/guest-site/amenity-templates?${query.toString()}`)
      setAmenityTemplates(Array.isArray(result.templates) ? result.templates : [])
      setTemplateStoreReady(!!result.schema_ready)
    } catch (error: any) {
      setAmenityTemplates([])
      setTemplateStoreReady(false)
      message.error(error?.message || '设施模板读取失败')
    }
  }

  function resetTemplateEditor() {
    setTemplateEditorId('')
    setTemplateName('')
    setTemplateScope('company')
    setTemplateCandidateKeys([])
  }

  function beginEdit(row: GuestSiteProperty, shouldPublish = false) {
    setEditing(row)
    setPublishIntent(shouldPublish)
    setAmenitySearch('')
    setCopySourceId('')
    setCustomAmenityLabel('')
    resetTemplateEditor()
    setAmenityTemplates([])
    setTemplateStoreReady(null)
    form.setFieldsValue(editorValues(row))
    setOpen(true)
    void loadAmenityTemplates(row)
  }

  function closeEditor() {
    setOpen(false)
    setEditing(null)
    setPublishIntent(false)
    resetTemplateEditor()
    setAmenityTemplates([])
    setTemplateStoreReady(null)
    form.resetFields()
  }

  function payloadFor(row: GuestSiteProperty, values: PropertyEditor, isPublished: boolean) {
    return {
      is_published: isPublished,
      hero_title: values.hero_title || '',
      short_description: values.short_description || '',
      long_description: values.long_description || '',
      hero_image_url: values.hero_image_url || '',
      gallery_urls: parseLineList(values.gallery_urls_text || ''),
      feature_tags: parseLineList(values.feature_tags_text || ''),
      amenities: row.amenities || [],
      amenity_selections: values.amenity_selections || [],
      house_rules: parseLineList(values.house_rules_text || ''),
      sort_order: Number(values.sort_order ?? row.sort_order ?? 0),
      public_region_label: values.public_region_label || '',
      public_capacity_override: values.public_capacity_override ?? null,
      bedroom_count: values.bedroom_count ?? null,
      bathroom_count: values.bathroom_count ?? null,
      bed_count: values.bed_count ?? null,
      checkin_time: guestSiteTimeForStorage(values.checkin_time),
      checkout_time: guestSiteTimeForStorage(values.checkout_time),
      location_note: values.location_note || '',
      price_label: values.price_label || '',
      booking_highlights: parseLineList(values.booking_highlights_text || ''),
    }
  }

  async function persist(row: GuestSiteProperty, values: PropertyEditor, isPublished: boolean, successText: string) {
    setSaving(true)
    try {
      await patchJSON(`/cms/guest-site/properties/${encodeURIComponent(row.id)}`, payloadFor(row, values, isPublished))
      message.success(successText)
      closeEditor()
      await load()
      return true
    } catch (error: any) {
      if (error?.message === 'property_not_ready_to_publish' && error?.publish_readiness?.items) {
        const missing = error.publish_readiness.items.filter((item: any) => !item.ready).map((item: any) => item.label).join('、')
        message.error(`还不能发布，请先完成：${missing}`)
      } else {
        message.error(error?.message || '保存失败')
      }
      return false
    } finally {
      setSaving(false)
    }
  }

  async function submitEditor(action: 'save' | 'publish') {
    if (!editing) return
    const values = await form.validateFields()
    values.amenity_selections = form.getFieldValue('amenity_selections') || []
    const publish = action === 'publish' || editing.is_published
    const readiness = clientPublishReadiness({ ...values, capacity: editing.capacity })
    if (publish && !readiness.ready) {
      const missing = readiness.items.filter((item) => !item.ready).map((item) => item.label).join('、')
      message.error(`还不能发布，请先完成：${missing}`)
      return
    }
    await persist(
      editing,
      values,
      publish,
      action === 'publish' ? '房源已上架' : editing.is_published ? '已更新公开房源内容' : '未发布内容已保存',
    )
  }

  function unpublish(row: GuestSiteProperty) {
    modal.confirm({
      title: '确认下架这套房源？',
      content: '下架后公开列表和详情将不可访问，后台内容会保留。',
      okText: '确认下架',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        setActionRowId(row.id)
        try {
          await persist(row, editorValues(row), false, '房源已下架，后台内容已保留')
        } finally {
          setActionRowId('')
        }
      },
    })
  }

  function bulkFollowSelected() {
    if (!canPublishPolicies) return message.error('当前账号没有规则发布权限')
    const selected = data.filter((row) => selectedPolicyIds.includes(row.id))
    if (!selected.length) return message.warning('请先选择至少一套房源')
    modal.confirm({
      title: `让 ${selected.length} 套房源跟随“${STAY_POLICY_META[bulkPolicySection].title}”？`,
      content: <div><p>这是显式公开模式变更。只改变所选分区，不会迁移或覆盖其他分区。</p><p>若任一房源 revision 已变化，整批操作会回滚。</p><p>{selected.map((row) => row.code || row.id).join('、')}</p></div>,
      okText: '确认整批跟随公司',
      cancelText: '取消',
      onOk: async () => {
        setBulkFollowing(true)
        try {
          const overviews = await Promise.all(selected.map((row) => getJSON<PropertyStayPolicyOverview>(`/cms/guest-site/stay-policies/properties/${encodeURIComponent(row.id)}`)))
          const sectionRows = overviews.map((overview) => overview.sections.find((item) => item.section === bulkPolicySection))
          if (sectionRows.some((item) => !item?.company_published)) throw new Error('company_policy_section_not_published')
          await postJSON(`/cms/guest-site/stay-policies/${bulkPolicySection}/bulk-follow`, {
            items: selected.map((row, index) => ({ property_id: row.id, expected_revision: sectionRows[index]?.mode?.revision || 0 })),
          })
          setSelectedPolicyIds([])
          message.success(`${selected.length} 套房源已显式改为跟随${STAY_POLICY_META[bulkPolicySection].title}`)
          await load()
        } catch (error: any) {
          message.error(error?.message === 'company_policy_section_not_published' ? '公司该分区尚未发布，不能改为跟随' : error?.message || '批量跟随失败')
          throw error
        } finally { setBulkFollowing(false) }
      },
    })
  }

  async function uploadFile(file: File) {
    const body = new FormData()
    body.append('file', file)
    const response = await fetch(`${API_BASE}/cms/guest-site/properties/upload-image`, { method: 'POST', headers: { ...authHeaders() }, body })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      throw new Error(String(payload?.message || `HTTP ${response.status}`))
    }
    const payload = await response.json().catch(() => ({}))
    const url = String(payload?.url || '')
    if (!url) throw new Error('missing_url')
    const current = form.getFieldValue('gallery_urls_text') || ''
    form.setFieldsValue({
      hero_image_url: form.getFieldValue('hero_image_url') || url,
      gallery_urls_text: current ? `${current}\n${url}` : url,
    })
    message.success('房源图片上传成功')
  }

  const uploadProps: UploadProps = {
    multiple: true,
    showUploadList: false,
    beforeUpload: (file) => {
      uploadFile(file as any).catch((error: any) => message.error(error?.message || '上传失败'))
      return false
    },
  }

  function openPersistedPreview(row: GuestSiteProperty) {
    setPreviewValues(editorValues(row))
    setPreviewNonce(window.crypto.randomUUID())
    setPreviewOpen(true)
  }

  async function openFormPreview() {
    const values = await form.validateFields().catch(() => form.getFieldsValue())
    setPreviewValues({ ...editing!, ...values, amenity_selections: form.getFieldValue('amenity_selections') || [] })
    setPreviewNonce(window.crypto.randomUUID())
    setPreviewOpen(true)
  }

  function closePreview() {
    setPreviewOpen(false)
    setPreviewValues(null)
    setPreviewNonce('')
  }

  function updateAmenityStatus(key: string, status: GuestSiteAmenityStatus | 'unset') {
    form.setFieldValue('amenity_selections', selectionWithStatus(watchedAmenitySelections, key, status))
  }

  function applyCandidateKeys(keys: string[], sourceLabel: string) {
    const result = mergeAmenityCandidates(watchedAmenitySelections, keys)
    confirmCandidateMerge(result, sourceLabel)
  }

  function applySelectionCandidates(candidates: GuestSiteAmenitySelection[], sourceLabel: string) {
    const result = mergeAmenitySelectionCandidates(watchedAmenitySelections, candidates)
    confirmCandidateMerge(result, sourceLabel)
  }

  function confirmCandidateMerge(result: ReturnType<typeof mergeAmenityCandidates>, sourceLabel: string) {
    if (!result.added.length) {
      message.info(`${sourceLabel}没有新的候选项；现有差异未被覆盖。`)
      return
    }
    modal.confirm({
      title: `应用${sourceLabel}？`,
      content: `将新增 ${result.added.length} 项“待确认”候选；${result.preserved.length} 项现有选择保持不变。候选不会公开，需逐项改为“已提供”。`,
      okText: '加入待确认',
      cancelText: '取消',
      onOk: () => form.setFieldValue('amenity_selections', result.selections),
    })
  }

  function applyStandardTemplate() {
    const template = catalog?.templates?.[0]
    if (!template) return message.error('设施模板暂不可用')
    applyCandidateKeys(template.amenity_keys, template.name_zh)
  }

  function applyBuildingCandidates() {
    if (!editing || !catalog) return
    const keys = buildingFacilityCandidateKeys(editing.building_facilities, catalog.items)
    if (!keys.length) {
      message.info('主房源没有可识别的楼宇设施资料；未作任何推断。')
      return
    }
    applyCandidateKeys(keys, `${editing.building_name || '当前楼宇'}资料候选`)
  }

  function applyLegacyCandidates() {
    if (!editing?.legacy_amenity_candidates?.length) {
      message.info('没有可载入的旧设施资料；未作任何推断。')
      return
    }
    applySelectionCandidates(editing.legacy_amenity_candidates, '旧设施资料候选')
  }

  function editManagedTemplate(template: GuestSiteAmenityTemplate) {
    setTemplateEditorId(template.id)
    setTemplateName(template.name)
    setTemplateScope(template.scope)
    setTemplateCandidateKeys((template.amenity_candidates || []).map((candidate) => candidate.key))
  }

  function applyManagedTemplate(template: GuestSiteAmenityTemplate) {
    if (!template.is_active) return message.warning('该模板已停用，重新启用后才能应用')
    applySelectionCandidates(
      pendingSelectionsFromTemplate(template.amenity_candidates || []),
      `${template.scope === 'company' ? '公司' : `楼宇 ${template.scope_key}`}模板“${template.name}”`,
    )
  }

  async function saveManagedTemplate() {
    if (!editing || !templateStoreReady) return
    const name = templateName.trim()
    if (!name) return message.warning('请填写模板名称')
    if (templateScope === 'building' && !String(editing.building_name || '').trim()) return message.warning('当前房源没有楼宇名称，不能建立楼宇模板')
    const candidates = amenityTemplateCandidatesFromKeys(templateCandidateKeys, catalog?.items || [], watchedAmenitySelections)
    if (!candidates.length || candidates.length !== new Set(templateCandidateKeys).size) return message.warning('请至少选择一项有效设施候选')
    setTemplateSaving(true)
    try {
      if (templateEditorId) {
        await patchJSON(`/cms/guest-site/amenity-templates/${encodeURIComponent(templateEditorId)}`, { name, amenity_candidates: candidates })
        message.success('设施模板已更新；现有房源不会被自动修改')
      } else {
        await postJSON('/cms/guest-site/amenity-templates', {
          scope: templateScope,
          scope_key: templateScope === 'building' ? String(editing.building_name || '').trim() : '',
          name,
          amenity_candidates: candidates,
        })
        message.success('设施模板已建立；应用时仍会先确认并全部加入待确认')
      }
      resetTemplateEditor()
      await loadAmenityTemplates(editing)
    } catch (error: any) {
      message.error(error?.message === 'amenity_template_name_exists' ? '同一范围已存在同名模板' : error?.message || '设施模板保存失败')
    } finally {
      setTemplateSaving(false)
    }
  }

  async function setManagedTemplateActive(template: GuestSiteAmenityTemplate, isActive: boolean) {
    if (!editing || !templateStoreReady) return
    setTemplateSaving(true)
    try {
      await patchJSON(`/cms/guest-site/amenity-templates/${encodeURIComponent(template.id)}`, { is_active: isActive })
      if (!isActive && templateEditorId === template.id) resetTemplateEditor()
      message.success(isActive ? '模板已重新启用' : '模板已停用；历史房源内容没有变化')
      await loadAmenityTemplates(editing)
    } catch (error: any) {
      message.error(error?.message || '设施模板状态更新失败')
    } finally {
      setTemplateSaving(false)
    }
  }

  function confirmManagedTemplateStatus(template: GuestSiteAmenityTemplate) {
    if (!template.is_active) {
      void setManagedTemplateActive(template, true)
      return
    }
    modal.confirm({
      title: `停用模板“${template.name}”？`,
      content: '停用后不能再应用，但不会删除模板记录，也不会修改任何房源的现有设施状态。',
      okText: '确认停用',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => setManagedTemplateActive(template, false),
    })
  }

  function previewCopy() {
    const source = data.find((item) => item.id === copySourceId)
    if (!source) return message.warning('请先选择参考房源')
    const current = { ...form.getFieldsValue(), amenity_selections: form.getFieldValue('amenity_selections') || [] }
    const result = copySafePropertyFields(current, source, copyFields)
    if (!result.copied.length) {
      message.info('所选字段已有内容或参考房源为空，没有需要复制的空项。')
      return
    }
    const labels = new Map(SAFE_COPY_FIELDS.map((item) => [item.key, item.label]))
    modal.confirm({
      title: '确认选择性复制？',
      content: `只填入当前为空的：${result.copied.map((key) => labels.get(key)).join('、')}。已有内容保持不变；标题、照片、人数、价格和位置不会复制。`,
      okText: '确认填入空项',
      cancelText: '取消',
      onOk: () => form.setFieldsValue(result.values),
    })
  }

  function addCustom() {
    if (!isReasonableEnglishLabel(customAmenityLabel)) {
      message.warning('自定义设施请填写 2–80 个字符的英文名称')
      return
    }
    const result = addCustomAmenity(watchedAmenitySelections, customAmenityLabel, customAmenityCategory)
    if (!result.added) return message.info('该自定义设施已经存在')
    form.setFieldValue('amenity_selections', result.selections)
    setCustomAmenityLabel('')
    message.success('已加入待确认；确认实际提供后再改为“已提供”')
  }

  const regionSummary = useMemo(() => Array.from(new Set(data.map((row) => row.public_region_label || row.region).filter(Boolean))), [data])
  const catalogByKey = useMemo(() => new Map((catalog?.items || []).map((item) => [item.key, item])), [catalog])
  const selectionByKey = useMemo(() => new Map(watchedAmenitySelections.map((item) => [item.key, item])), [watchedAmenitySelections])
  const visibleCatalog = useMemo(() => {
    const query = amenitySearch.trim().toLowerCase()
    return (catalog?.items || []).filter((item) => !query || `${item.label_zh} ${item.label_en} ${item.category_label_zh} ${item.category_label_en}`.toLowerCase().includes(query))
  }, [amenitySearch, catalog])
  const amenityGroups = useMemo(() => (catalog?.categories || []).map((group) => ({
    ...group,
    items: visibleCatalog.filter((item) => item.category_key === group.key),
  })).filter((group) => group.items.length), [catalog, visibleCatalog])
  const customSelections = watchedAmenitySelections.filter((item) => !catalogByKey.has(item.key))
  const templateCandidateOptions = useMemo(() => {
    const options = (catalog?.items || []).map((item) => ({
      value: item.key,
      label: `${item.label_zh} · ${item.label_en}${item.company_default_status === 'provided' ? '（公司默认，无需加入模板）' : ''}`,
      disabled: item.company_default_status === 'provided',
    }))
    const custom = new Map<string, string>()
    for (const selection of watchedAmenitySelections) {
      if (!catalogByKey.has(selection.key) && isReasonableEnglishLabel(selection.custom_label || '')) custom.set(selection.key, String(selection.custom_label))
    }
    for (const template of amenityTemplates) {
      for (const candidate of template.amenity_candidates || []) {
        if (!catalogByKey.has(candidate.key) && isReasonableEnglishLabel(candidate.custom_label || '')) custom.set(candidate.key, String(candidate.custom_label))
      }
    }
    return [...options, ...Array.from(custom, ([value, label]) => ({ value, label: `Custom · ${label}` }))]
  }, [amenityTemplates, catalog, catalogByKey, watchedAmenitySelections])
  const propertyAmenitySelections = watchedAmenitySelections.filter((item) => !isCompanyDefaultAmenityKey(item.key))
  const amenityCounts = propertyAmenitySelections.reduce((counts, item) => ({ ...counts, [item.status]: counts[item.status] + 1 }), { provided: 0, not_provided: 0, pending: 0 })
  const companyDefaultAmenityCount = (catalog?.items || []).filter((item) => item.company_default_status === 'provided').length
  const companyDefaultConflicts = companyDefaultAmenityConflicts(watchedAmenitySelections)
  const liveReadiness = editing ? clientPublishReadiness({
    ...watchedValues,
    checkin_time: watchedCheckinTime,
    checkout_time: watchedCheckoutTime,
    capacity: editing.capacity,
    amenity_selections: watchedAmenitySelections,
  }) : null
  const standardTimesSelected = canonicalGuestSiteTime(watchedCheckinTime) === STANDARD_CHECKIN_TIME
    && canonicalGuestSiteTime(watchedCheckoutTime) === STANDARD_CHECKOUT_TIME

  const previewProperty = useMemo(() => previewValues ? buildGuestSiteDraftPreview(previewValues, {
    ...previewValues,
    gallery_urls: parseLineList(previewValues.gallery_urls_text || ''),
    feature_tags: parseLineList(previewValues.feature_tags_text || ''),
    house_rules: parseLineList(previewValues.house_rules_text || ''),
    booking_highlights: parseLineList(previewValues.booking_highlights_text || ''),
  }, catalog?.items || []) : null, [previewValues, catalog])
  const previewUrl = previewNonce
    ? `${BOOKING_SITE_BASE.replace(/\/+$/g, '')}/property-preview#${previewNonce}`
    : ''

  const sendPreviewToFrame = useCallback(() => {
    const target = previewFrameRef.current?.contentWindow
    if (!target || !previewProperty || !previewNonce || !BOOKING_SITE_ORIGIN) return
    target.postMessage({ type: 'mz-admin-property-preview', nonce: previewNonce, property: previewProperty }, BOOKING_SITE_ORIGIN)
  }, [previewNonce, previewProperty])

  useEffect(() => {
    if (!previewOpen || !previewNonce || !BOOKING_SITE_ORIGIN) return
    const receiveReady = (event: MessageEvent) => {
      if (event.origin !== BOOKING_SITE_ORIGIN || event.source !== previewFrameRef.current?.contentWindow) return
      if (event.data?.type !== 'mz-property-preview-ready' || event.data?.nonce !== previewNonce) return
      sendPreviewToFrame()
    }
    window.addEventListener('message', receiveReady)
    return () => window.removeEventListener('message', receiveReady)
  }, [previewOpen, previewNonce, sendPreviewToFrame])

  return (
    <>
      <Card title="预订网站房源展示" extra={<Space><Button onClick={() => void load()} disabled={loading}>刷新</Button></Space>}>
        <Alert
          type="info"
          showIcon
          message="中文后台维护，英文网站发布"
          description="公开房源按排序值升序展示，首页取前 3 套。设施只有标记为“已提供”的项目才会公开；待确认和不提供都不会出现在网站。"
          className={styles.pageAlert}
        />
        <Typography.Paragraph type="secondary">
          当前区域：{regionSummary.length ? regionSummary.join(' / ') : '暂无'}。标题、图片、人数、价格和位置不会在模板或复制操作中自动覆盖。
        </Typography.Paragraph>
        <Card size="small" title="显式批量跟随公司规则" style={{ marginBottom: 16 }}>
          <Space wrap>
            <Select aria-label="批量跟随分区" value={bulkPolicySection} onChange={setBulkPolicySection} style={{ width: 220 }} options={STAY_POLICY_SECTIONS.map((section) => ({ value: section, label: STAY_POLICY_META[section].title }))} />
            <Button data-bulk-follow-policy type="primary" disabled={!canPublishPolicies || !selectedPolicyIds.length} loading={bulkFollowing} onClick={bulkFollowSelected}>选中房源改为跟随公司（{selectedPolicyIds.length}）</Button>
            {!canPublishPolicies ? <Tag color="orange">无规则发布权限</Tag> : <Typography.Text type="secondary">先在下表勾选房源；只改变当前选中分区。</Typography.Text>}
          </Space>
        </Card>
        <Table
          rowKey="id"
          loading={loading}
          dataSource={data}
          rowSelection={{ selectedRowKeys: selectedPolicyIds, onChange: setSelectedPolicyIds, getCheckboxProps: () => ({ disabled: !canPublishPolicies }) }}
          pagination={{ defaultPageSize: 20, showSizeChanger: true }}
          scroll={{ x: 'max-content' }}
          columns={[
            { title: '排序', dataIndex: 'sort_order', width: 80 },
            { title: '区域', dataIndex: 'public_region_label', width: 140, render: (_: any, row: GuestSiteProperty) => row.public_region_label || row.region || '-' },
            { title: '房号', dataIndex: 'code', width: 110 },
            { title: '前台标题', dataIndex: 'hero_title', render: (_: any, row: GuestSiteProperty) => row.hero_title || row.airbnb_listing_name || row.address || '-' },
            { title: '房型', dataIndex: 'type', width: 140, render: (value: string) => value || '-' },
            { title: '人数', dataIndex: 'capacity', width: 80, render: (_: any, row: GuestSiteProperty) => row.public_capacity_override || row.capacity || '-' },
            {
              title: '发布检查',
              width: 130,
              render: (_: any, row: GuestSiteProperty) => {
                const readiness = row.publish_readiness
                const done = readiness?.items.filter((item) => item.ready).length || 0
                const total = readiness?.items.length || 8
                return <Tag color={readiness?.ready ? 'green' : 'orange'}>{readiness?.ready ? '可发布' : `${done}/${total} 完成`}</Tag>
              },
            },
            { title: '状态', dataIndex: 'is_published', width: 100, render: (value: boolean) => <Tag color={value ? 'green' : 'default'}>{value ? '已上架' : '未上架'}</Tag> },
            {
              title: '操作',
              width: 560,
              render: (_: any, row: GuestSiteProperty) => (
                <TableRowActions actions={[
                  { key: 'preview', label: '后台预览', onClick: () => openPersistedPreview(row) },
                  { key: 'edit', label: '编辑', onClick: () => beginEdit(row), hidden: !canWriteProperties, dataAttributes: { 'data-edit-current': row.id } },
                  { key: 'policy', label: '规则来源', onClick: () => setPolicyProperty(row), dataAttributes: { 'data-policy-current': row.id } },
                  { key: 'public', label: '打开公开页', onClick: () => window.open(`${BOOKING_SITE_BASE.replace(/\/+$/g, '')}/properties/${encodeURIComponent(row.id)}`, '_blank'), hidden: !row.is_published },
                  { key: 'publish', label: '编辑并发布', onClick: () => beginEdit(row, true), hidden: row.is_published || !canWriteProperties, dataAttributes: { 'data-edit-and-publish': row.id } },
                  { key: 'unpublish', label: '下架', onClick: () => unpublish(row), hidden: !row.is_published || !canWriteProperties, danger: true, loading: actionRowId === row.id },
                ]} />
              ),
            },
          ]}
        />
      </Card>

      <Drawer
        open={open}
        onClose={closeEditor}
        width={920}
        rootClassName={styles.editorDrawer}
        title={editing ? `编辑房源展示：${editing.code || editing.address}` : '编辑房源展示'}
        extra={(
          <Space wrap className={styles.editorActions}>
            <Button data-preview-current onClick={() => void openFormPreview()}>后台预览</Button>
            <Button onClick={closeEditor}>取消</Button>
            <Button data-save-current onClick={() => void submitEditor('save')} loading={saving}>
              {editing?.is_published ? '保存并更新公开内容' : '保存未发布内容'}
            </Button>
            {!editing?.is_published ? <Button type="primary" data-publish-current onClick={() => void submitEditor('publish')} loading={saving}>{publishIntent ? '完成检查并发布' : '发布'}</Button> : null}
          </Space>
        )}
      >
        {editing ? (
          <>
            <Card size="small" className={styles.sourceCard}>
              <div className={styles.sourceGrid}>
                <span><strong>房号</strong>{editing.code || '-'}</span>
                <span><strong>主房源区域</strong>{editing.region || '-'}</span>
                <span><strong>楼宇</strong>{editing.building_name || '-'}</span>
                <span><strong>主房源房型</strong>{editing.type || '-'}</span>
                <span><strong>Airbnb 标题</strong>{editing.airbnb_listing_name || '-'}</span>
                <span><strong>主房源人数</strong>{editing.capacity || '-'}</span>
              </div>
            </Card>

            {editing.is_published ? (
              <Alert type="warning" showIcon message="这套房源已公开" description="这里没有独立版本草稿。保存会立即更新公开内容；如需离线整理，请先下架。" className={styles.editorAlert} />
            ) : (
              <Alert type="info" showIcon message="当前内容未公开" description="可以反复保存未发布内容，并使用后台预览检查；只有点击“发布”且通过检查后才会公开。" className={styles.editorAlert} />
            )}

            <Form form={form} layout="vertical" className={styles.editorForm}>
              <Card size="small" title="1. 基础信息" className={styles.sectionCard}>
                <div className={styles.formGrid4}>
                  <Form.Item name="sort_order" label="排序值" extra="越小越靠前；0 是最高优先级。"><InputNumber min={0} max={99999} /></Form.Item>
                  <Form.Item name="public_region_label" label="前台区域名称" extra="用于卡片、筛选和约 500m 区域地图；不要填精确地址。"><Input placeholder="例如：Docklands" /></Form.Item>
                  <Form.Item name="public_capacity_override" label="前台人数覆盖" extra="留空使用主房源人数。"><InputNumber min={1} max={100} /></Form.Item>
                  <Form.Item label="主房源房型"><Input value={editing.type || ''} disabled /></Form.Item>
                </div>
                <div className={styles.formGrid3}>
                  <Form.Item name="bedroom_count" label="卧室数"><InputNumber min={0} max={20} /></Form.Item>
                  <Form.Item name="bathroom_count" label="浴室数"><InputNumber min={0} max={20} /></Form.Item>
                  <Form.Item name="bed_count" label="床数"><InputNumber min={0} max={20} /></Form.Item>
                </div>
              </Card>

              <Card size="small" title="2. 照片与英文介绍" className={styles.sectionCard}>
                <Form.Item name="hero_title" label="前台英文主标题" extra="显示：首页推荐卡、全部房源卡、详情页标题。"><Input placeholder="例如：Waterfront one-bedroom stay in Docklands" /></Form.Item>
                <Form.Item name="short_description" label="英文简短介绍" extra="显示：全部房源卡和详情页首段。"><Input.TextArea rows={3} placeholder="用 1–2 句英文概括最重要的住宿体验。" /></Form.Item>
                <Form.Item name="long_description" label="英文详细介绍" extra="显示：详情页 Read more。"><Input.TextArea rows={6} /></Form.Item>
                <Form.Item name="hero_image_url" label="封面图片链接"><Input placeholder="上传第一张图片后自动填入，也可从下方图库设为封面。" /></Form.Item>
                <Form.Item name="gallery_urls_text" label="房源图片"><Input.TextArea rows={5} placeholder="每行一个图片链接；顺序即详情图库顺序。" /></Form.Item>
                <Form.Item label="图片管理">
                  <Space direction="vertical" size={12} className={styles.fullWidth}>
                    <Upload {...uploadProps}><Button>上传房源图片（可多选）</Button></Upload>
                    <Typography.Text type="secondary">上传仅追加图片，不会覆盖现有照片；点击缩略图按钮可设封面。</Typography.Text>
                    {(watchedHeroImageUrl || currentGallery.length) ? (
                      <div className={styles.imageGrid}>
                        {currentGallery.map((url, index) => {
                          const isCover = url === watchedHeroImageUrl || (!watchedHeroImageUrl && index === 0)
                          return (
                            <div className={isCover ? styles.imageCardCover : styles.imageCard} key={`${url}-${index}`}>
                              <img src={url} alt={`房源图 ${index + 1}`} />
                              <div><Typography.Text>{isCover ? `图片 ${index + 1} · 当前封面` : `图片 ${index + 1}`}</Typography.Text><Button size="small" type={isCover ? 'primary' : 'default'} onClick={() => form.setFieldValue('hero_image_url', url)}>{isCover ? '封面照' : '设为封面'}</Button></div>
                            </div>
                          )
                        })}
                      </div>
                    ) : <Typography.Text type="secondary">还没有上传图片。</Typography.Text>}
                  </Space>
                </Form.Item>
              </Card>

              <Card size="small" title="3. 设施与入住方式" className={styles.sectionCard}>
                <Form.Item name="feature_tags_text" label="房源概览标签" extra="显示：详情页 Overview 标签行。每行一项，建议使用 Entire apartment、Self check-in；设施不要重复填在这里。">
                  <Input.TextArea rows={3} placeholder={'Entire apartment\nSelf check-in'} />
                </Form.Item>

                <div className={styles.templatePanel}>
                  <div><strong>候选模板</strong><p>只补充空缺候选且一律标为“待确认”；不会覆盖已有差异，也不会自动公开。</p></div>
                  <Space wrap><Button data-apply-standard-template onClick={applyStandardTemplate}>应用标准公寓候选</Button><Button data-apply-building-template onClick={applyBuildingCandidates}>载入本楼宇资料候选</Button><Button data-apply-legacy-candidates onClick={applyLegacyCandidates}>载入旧设施资料候选</Button></Space>
                </div>

                <Card
                  size="small"
                  title="公司／楼宇可维护设施模板"
                  extra={templateStoreReady ? <Button size="small" data-template-new onClick={resetTemplateEditor}>新建模板</Button> : null}
                >
                  {templateStoreReady == null ? <Alert type="info" showIcon message="正在读取可维护模板…" /> : null}
                  {templateStoreReady === false ? (
                    <Alert
                      type="warning"
                      showIcon
                      message="可维护模板存储尚未启用"
                      description="当前环境尚未执行单独审批的设施模板 migration。现有标准候选、楼宇资料候选及逐房源设施编辑仍可使用；不会尝试运行时建表。"
                    />
                  ) : null}
                  {templateStoreReady ? (
                    <Space direction="vertical" size={12} className={styles.fullWidth} data-managed-template-section>
                      {amenityTemplates.length ? amenityTemplates.map((template) => (
                        <div className={styles.templatePanel} key={template.id} data-managed-template={template.id}>
                          <div>
                            <Space wrap><strong>{template.name}</strong><Tag color={template.scope === 'company' ? 'blue' : 'purple'}>{template.scope === 'company' ? '公司' : `楼宇 · ${template.scope_key}`}</Tag>{template.is_active ? <Tag color="green">启用</Tag> : <Tag>已停用</Tag>}</Space>
                            <p>{template.amenity_candidates.length} 项候选；应用后全部为待确认，不覆盖当前房源例外。</p>
                          </div>
                          <Space wrap>
                            <Button size="small" disabled={!template.is_active} data-template-apply={template.id} onClick={() => applyManagedTemplate(template)}>应用</Button>
                            <Button size="small" data-template-edit={template.id} onClick={() => editManagedTemplate(template)}>编辑</Button>
                            <Button size="small" danger={template.is_active} data-template-toggle={template.id} onClick={() => confirmManagedTemplateStatus(template)}>{template.is_active ? '停用' : '启用'}</Button>
                          </Space>
                        </div>
                      )) : <Typography.Text type="secondary">当前公司及本楼宇还没有可维护模板。</Typography.Text>}
                      <Card size="small" type="inner" title={templateEditorId ? '编辑模板' : '新建模板'}>
                        <Space direction="vertical" size={10} className={styles.fullWidth}>
                          <Input aria-label="设施模板名称" data-template-name value={templateName} maxLength={120} onChange={(event) => setTemplateName(event.target.value)} placeholder="例如：公司标准公寓候选" />
                          <Select
                            aria-label="设施模板范围"
                            data-template-scope
                            style={{ width: '100%' }}
                            value={templateScope}
                            disabled={!!templateEditorId}
                            onChange={setTemplateScope}
                            options={[
                              { value: 'company', label: '公司模板' },
                              { value: 'building', label: `楼宇模板${editing.building_name ? ` · ${editing.building_name}` : '（当前房源无楼宇名称）'}`, disabled: !editing.building_name },
                            ]}
                          />
                          <Select
                            aria-label="设施模板候选"
                            data-template-candidates
                            style={{ width: '100%' }}
                            mode="multiple"
                            showSearch
                            optionFilterProp="label"
                            value={templateCandidateKeys}
                            onChange={setTemplateCandidateKeys}
                            options={templateCandidateOptions}
                            placeholder="选择设施候选；保存模板不会修改房源"
                          />
                          <Space wrap>
                            <Button type="primary" data-template-save loading={templateSaving} onClick={() => void saveManagedTemplate()}>{templateEditorId ? '保存模板修改' : '建立模板'}</Button>
                            {templateEditorId ? <Button onClick={resetTemplateEditor}>取消编辑</Button> : null}
                          </Space>
                        </Space>
                      </Card>
                    </Space>
                  ) : null}
                </Card>

                <div className={styles.copyPanel}>
                  <div><strong>从类似房源选择性复制</strong><p>只填当前为空的公共字段；不复制标题、照片、人数、价格或位置。</p></div>
                  <Select
                    className={styles.copySource}
                    data-copy-source
                    value={copySourceId || undefined}
                    placeholder="选择参考房源"
                    onChange={setCopySourceId}
                    options={data.filter((row) => row.id !== editing.id).map((row) => ({ value: row.id, label: `${row.code || row.id} · ${row.hero_title || row.airbnb_listing_name || '未命名'}` }))}
                  />
                  <Checkbox.Group value={copyFields} onChange={(values) => setCopyFields(values as SafeCopyField[])} options={SAFE_COPY_FIELDS.map((item) => ({ label: item.label, value: item.key }))} />
                  <Button data-copy-apply onClick={previewCopy}>预览并填入空项</Button>
                </div>

                <div className={styles.amenityHeader}>
                  <div><strong>设施确认</strong><p>Baby cot 和 High chair 是公司确认的全房默认设施，无需逐套标记；其他设施只有“已提供”才会公开。</p></div>
                  <Space wrap><Tag color="green">公司默认 {companyDefaultAmenityCount}</Tag><Tag color="green">单套已提供 {amenityCounts.provided}</Tag><Tag>不提供 {amenityCounts.not_provided}</Tag><Tag color="orange">待确认 {amenityCounts.pending}</Tag></Space>
                </div>
                {companyDefaultConflicts.length ? <Alert type="error" showIcon message="发现与公司默认婴儿设施冲突的单套记录" description="请在对应项目选择“恢复公司默认”移除旧的“不提供/待确认”记录；系统不会批量覆盖房源数据。" className={styles.editorAlert} /> : null}
                <Input allowClear value={amenitySearch} onChange={(event) => setAmenitySearch(event.target.value)} placeholder="搜索中文分类、中文名称或英文名称" className={styles.amenitySearch} />
                <Collapse
                  key={`amenity-catalog-${catalog?.items.length || 0}`}
                  className={styles.amenityCollapse}
                  defaultActiveKey={catalog?.categories.map((item) => item.key)}
                  items={amenityGroups.map((group) => ({
                    key: group.key,
                    label: `${group.label_zh} · ${group.label_en}`,
                    children: (
                      <div className={styles.amenityList}>
                        {group.items.map((item) => {
                          const selection = selectionByKey.get(item.key)
                          const status = selection?.status || 'unset'
                          const companyDefault = item.company_default_status === 'provided'
                          return (
                            <div className={styles.amenityRow} key={item.key} data-amenity-key={item.key}>
                              <div><strong>{item.label_zh}</strong><span>{item.label_en}</span></div>
                              {companyDefault ? <Space wrap>
                                <Tag color="green">公司默认 · 全房已提供</Tag>
                                {selection ? <>
                                  {status !== 'provided' ? <Tag color="red">单套记录冲突：{status === 'not_provided' ? '不提供' : '待确认'}</Tag> : <Tag>存在冗余单套记录</Tag>}
                                  <Button size="small" data-clear-company-default-conflict={item.key} onClick={() => updateAmenityStatus(item.key, 'unset')}>恢复公司默认</Button>
                                </> : null}
                              </Space> : <Radio.Group value={status} onChange={(event) => updateAmenityStatus(item.key, event.target.value)} buttonStyle="solid" size="small">
                                <Radio.Button value="unset">未设置</Radio.Button>
                                <Radio.Button value="provided">已提供</Radio.Button>
                                <Radio.Button value="not_provided">不提供</Radio.Button>
                                <Radio.Button value="pending">待确认</Radio.Button>
                              </Radio.Group>}
                            </div>
                          )
                        })}
                      </div>
                    ),
                  }))}
                />

                <div className={styles.customAmenityPanel}>
                  <div><strong>自定义英文设施</strong><p>标准目录没有时使用。新增后先进入“待确认”，确认实际提供后再改状态。</p></div>
                  <div className={styles.customAmenityForm}>
                    <Input value={customAmenityLabel} onChange={(event) => setCustomAmenityLabel(event.target.value)} placeholder="English amenity name" />
                    <Select value={customAmenityCategory} onChange={setCustomAmenityCategory} options={[...(catalog?.categories || []).map((item) => ({ value: item.label_en, label: item.label_en })), { value: 'Other', label: 'Other' }]} />
                    <Button onClick={addCustom}>加入待确认</Button>
                  </div>
                  {customSelections.length ? <div className={styles.amenityList}>{customSelections.map((item) => (
                    <div className={styles.amenityRow} key={item.key}>
                      <div><strong>{item.custom_label || item.key}</strong><span>{item.custom_category || 'Other'}</span></div>
                      <Radio.Group value={item.status} onChange={(event) => updateAmenityStatus(item.key, event.target.value)} buttonStyle="solid" size="small">
                        <Radio.Button value="unset">删除</Radio.Button><Radio.Button value="provided">已提供</Radio.Button><Radio.Button value="not_provided">不提供</Radio.Button><Radio.Button value="pending">待确认</Radio.Button>
                      </Radio.Group>
                    </div>
                  ))}</div> : null}
                </div>
              </Card>

              <Card size="small" title="4. 规则与时间" className={styles.sectionCard}>
                <Alert
                  type="info"
                  showIcon
                  message="已确认的公司标准"
                  description="标准入住 3PM、退房 10AM。早入住免费，需提前申请，团队会尽量安排但不保证；晚退房到 11:30AM 为 A$20，需按实际可用情况人工确认；提前放行李也需提前沟通确认，并不代表房源已经可以入住。"
                  className={styles.editorAlert}
                />
                <div className={styles.formGrid2}>
                  <Form.Item name="checkin_time" label="标准入住时间" extra="发布标准：3PM；旧格式会自动转换。">
                    <Select data-checkin-time-select options={guestSiteTimeOptions(watchedCheckinTime, STANDARD_CHECKIN_TIME)} />
                  </Form.Item>
                  <Form.Item name="checkout_time" label="标准退房时间" extra="发布标准：10AM；旧格式会自动转换。">
                    <Select data-checkout-time-select options={guestSiteTimeOptions(watchedCheckoutTime, STANDARD_CHECKOUT_TIME)} />
                  </Form.Item>
                </div>
                {!standardTimesSelected ? <Alert type="warning" showIcon message="请选择公司标准时间" description="已有非标准值已保留，不会被静默覆盖。公开前请选择入住 3PM、退房 10AM。" className={styles.editorAlert} /> : null}
                <Form.Item name="house_rules_text" label="英文房屋守则" extra="显示：详情页 Before you arrive 与完整规则弹层。每行一条。"><Input.TextArea rows={4} placeholder={'No smoking\nNo pets'} /></Form.Item>
                <Form.Item name="booking_highlights_text" label="英文预订区提示" extra="显示：桌面预订侧栏及手机预订提示区，不再并入 Overview。每行一条。"><Input.TextArea rows={3} placeholder="Long-stay enquiries welcome" /></Form.Item>
              </Card>

              <Card size="small" title="5. 价格提示" className={styles.sectionCard}>
                <Alert type="warning" showIcon message="PMS 实时价格尚未接入" description="该字段当前只是旧静态文案，不代表平台实时价格。不会自动创建订单、收费或确认申请。" className={styles.editorAlert} />
                <Form.Item name="price_label" label="旧静态价格文案（非实时）" extra="等待确认公开端隐藏或改为明确的 indicative 文案；未来由 PMS 价格接口替代。"><Input placeholder="例如：A$128（非实时，仅旧资料）" /></Form.Item>
              </Card>

              <Card size="small" title="6. 地图范围与内部备注" className={styles.sectionCard}>
                <Alert type="info" showIcon message="公开地图只使用上方“前台区域名称”的约 500m 参考范围" description="不会公开精确地址、坐标或下面的内部备注；当前没有后台精确地图中心设置。" className={styles.editorAlert} />
                <Form.Item name="location_note" label="内部位置备注（不公开）" extra="仅后台保存，不进入公开 API，也不影响地图。"><Input.TextArea rows={3} /></Form.Item>
              </Card>

              <Card size="small" title="7. 发布检查" className={styles.sectionCard}>
                <div className={styles.readinessGrid}>
                  {liveReadiness?.items.map((item) => (
                    <div className={item.ready ? styles.readinessReady : styles.readinessMissing} key={item.key}>
                      <span aria-hidden="true">{item.ready ? '✓' : '!'}</span><div><strong>{item.label}</strong><p>{item.ready ? '已完成' : item.message}</p></div>
                    </div>
                  ))}
                </div>
                <Alert type={liveReadiness?.ready ? 'success' : 'warning'} showIcon message={liveReadiness?.ready ? '已满足发布条件' : '尚未满足发布条件'} description="后台与 API 会执行同一组必要检查；未通过时不能上架。" />
              </Card>
            </Form>
          </>
        ) : null}
      </Drawer>

      <PropertyPolicyDrawer open={!!policyProperty} property={policyProperty} onClose={() => setPolicyProperty(null)} onChanged={() => void load()} />

      <Drawer open={previewOpen} onClose={closePreview} width="min(1200px, 100vw)" title="真实详情布局 · 权限内草稿预览" destroyOnClose>
        <Alert
          type="info"
          showIcon
          message={previewValues?.is_published ? '当前表单的详情布局预览' : '未发布草稿的详情布局预览'}
          description="使用与公开详情页相同的渲染组件。草稿仅从当前已认证后台以内存消息传入；不会创建公开草稿链接、读取公开房源 API、请求 availability 或保存 token。"
          className={styles.editorAlert}
        />
        {previewProperty && previewUrl ? (
          <iframe
            ref={previewFrameRef}
            data-admin-property-preview
            src={previewUrl}
            title="Property detail draft preview"
            sandbox="allow-scripts allow-same-origin"
            onLoad={sendPreviewToFrame}
            style={{ display: 'block', width: '100%', height: 'calc(100dvh - 155px)', minHeight: 480, border: '1px solid #d9d9d9', borderRadius: 8, background: '#f7f0e6' }}
          />
        ) : <div className={styles.previewEmpty}>正在准备草稿预览…</div>}
      </Drawer>
    </>
  )
}
