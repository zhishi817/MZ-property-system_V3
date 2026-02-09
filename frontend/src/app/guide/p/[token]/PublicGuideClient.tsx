"use client"
import React, { useEffect, useMemo, useState } from 'react'
import { Alert, App, Button, Card, Input, Spin, Tabs, Tooltip } from 'antd'
import { API_BASE } from '../../../../lib/api'
import styles from './PublicGuide.module.css'
import { EnvironmentOutlined, ClockCircleOutlined, WifiOutlined, InfoCircleOutlined, LogoutOutlined, CompassOutlined, CheckCircleFilled, CopyOutlined } from '@ant-design/icons'

type GuideStep = { title?: string; text?: string; url?: string; caption?: string }
type GuideBlock =
  | { type: 'heading'; text?: string }
  | { type: 'text'; text?: string }
  | { type: 'image'; url?: string; caption?: string }
  | { type: 'steps'; title?: string; steps?: GuideStep[] }
  | { type: 'wifi'; ssid?: string; password?: string; router_location?: string }
  | { type: 'notice'; title?: string; items?: string[]; text?: string }
type GuideSection = { title?: string; blocks?: GuideBlock[] }
type GuideMeta = {
  badge?: string
  title?: string
  address?: string
  cover_image_url?: string
  wifi_ssid?: string
  wifi_password?: string
  checkin_time?: string
  checkout_time?: string
}
type GuideContent = { meta?: GuideMeta; sections?: GuideSection[] }

function normalizeTitle(s?: string): string {
  return String(s || '').trim().toLowerCase()
}

function findFirstImage(sections: GuideSection[]): string {
  for (const sec of sections) {
    for (const b of (sec.blocks || []) as any[]) {
      if (b?.type === 'image' && b?.url) return String(b.url)
      if (b?.type === 'steps') {
        for (const st of (b.steps || []) as any[]) {
          if (st?.url) return String(st.url)
        }
      }
    }
  }
  return ''
}

function findWifi(sections: GuideSection[]): { ssid?: string; password?: string } {
  for (const sec of sections) {
    for (const b of (sec.blocks || []) as any[]) {
      if (b?.type === 'wifi') return { ssid: b?.ssid || '', password: b?.password || '' }
    }
  }
  return {}
}

function mapTabs(sections: GuideSection[], isEn: boolean) {
  const ordered: Array<{ key: string; label: string; icon: React.ReactNode; section: GuideSection }> = []
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]
    const t = normalizeTitle(s.title)
    const id = String((s as any)?.id || '')
    const key = `sec-${id || i}`
    let icon: React.ReactNode = <InfoCircleOutlined />
    if (t.includes('守则') || t.includes('rules')) icon = <CheckCircleFilled />
    else if (t.includes('周边') || t.includes('around') || t.includes('附近')) icon = <CompassOutlined />
    else if (t.includes('退房') || t.includes('check-out') || t.includes('check out')) icon = <LogoutOutlined />
    ordered.push({ key, label: s.title || (isEn ? 'Content' : '内容'), icon, section: s })
  }
  return ordered
}

function renderSection(section: GuideSection, tabKey: string, isEn: boolean) {
  const blocks = Array.isArray(section.blocks) ? section.blocks : []
  const nodes: React.ReactNode[] = []
  for (let i = 0; i < blocks.length; i++) {
    const b: any = blocks[i]
    if (!b || !b.type) continue
    const anchorId = `toc-${tabKey}-b-${i}`
    if (b.type === 'heading') {
      nodes.push(
        <div key={`h-${i}`} id={anchorId} className={styles.anchor}>
          <div className={styles.sectionTitleRow}>
            <span style={{ color: '#ff4d6d' }}><InfoCircleOutlined /></span>
            <div className={styles.sectionTitle}>{b.text || ''}</div>
          </div>
        </div>
      )
      continue
    }
    if (b.type === 'text') {
      nodes.push(<div key={`t-${i}`} id={anchorId} className={`${styles.paragraph} ${styles.anchor}`}>{b.text || ''}</div>)
      continue
    }
    if (b.type === 'image') {
      nodes.push(
        <div key={`img-${i}`} id={anchorId} className={styles.anchor}>
          <div className={styles.imageBlock}>
            {b.url ? <img className={styles.mediaImg} src={b.url} alt="" /> : null}
            {b.caption ? <div className={styles.imageCaption}>{b.caption}</div> : null}
          </div>
        </div>
      )
      continue
    }
    if (b.type === 'notice') {
      const items: string[] = Array.isArray(b.items) ? b.items.filter(Boolean) : []
      nodes.push(
        <div key={`n-${i}`} id={anchorId} className={styles.anchor}>
          {b.title ? <div className={styles.sectionTitleRow}><span style={{ color: '#ff4d6d' }}><InfoCircleOutlined /></span><div className={styles.sectionTitle}>{b.title}</div></div> : null}
          <div className={styles.pillList}>
            {items.map((it, idx) => (
              <div key={idx} className={styles.pill}>
                <span className={styles.pillIcon}><CheckCircleFilled /></span>
                <span>{it}</span>
              </div>
            ))}
            {b.text ? (
              <div className={styles.pill}>
                <span className={styles.pillIcon}><CheckCircleFilled /></span>
                <span style={{ whiteSpace: 'pre-wrap' }}>{String(b.text)}</span>
              </div>
            ) : null}
          </div>
        </div>
      )
      continue
    }
    if (b.type === 'steps') {
      const steps: GuideStep[] = Array.isArray(b.steps) ? b.steps : []
      nodes.push(
        <div key={`steps-${i}`} id={anchorId} className={styles.anchor}>
          <div className={styles.sectionTitleRow}>
            <span style={{ color: '#ff4d6d' }}><InfoCircleOutlined /></span>
            <div className={styles.sectionTitle}>{b.title || (isEn ? 'Step-by-step' : '分步指引')}</div>
          </div>
          <div className={styles.timeline}>
            {steps.map((s, idx) => (
              <div key={idx} className={styles.stepRow}>
                <div className={styles.stepNo}>{idx + 1}</div>
                {s.title ? <div className={styles.stepTitle}>{s.title}</div> : null}
                {s.text ? <div className={styles.stepDesc}>{s.text}</div> : null}
                {s.url ? (
                  <div className={styles.media}>
                    <img className={styles.mediaImg} src={s.url} alt="" />
                  </div>
                ) : null}
                {s.caption ? <div className={styles.imageCaption}>{s.caption}</div> : null}
              </div>
            ))}
          </div>
        </div>
      )
      continue
    }
    if (b.type === 'wifi') {
      const ssid = String(b.ssid || '').trim()
      const pwd = String(b.password || '').trim()
      const routerLoc = String(b.router_location || '').trim()
      nodes.push(
        <div key={`wifi-${i}`} id={anchorId} className={styles.anchor}>
          <Card size="small" className={styles.sectionCard}>
            <div className={styles.sectionTitleRow}>
              <span style={{ color: '#1677ff' }}><WifiOutlined /></span>
              <div className={styles.sectionTitle}>Wi‑Fi</div>
            </div>
            <div className={styles.paragraph}><b>SSID：</b>{ssid || '-'}</div>
            <div className={styles.paragraph}><b>Password：</b>{pwd || '-'}</div>
            {routerLoc ? <div className={styles.paragraph}><b>Router：</b>{routerLoc}</div> : null}
          </Card>
        </div>
      )
      continue
    }
  }
  if (!nodes.length) return <div className={styles.paragraph}>{isEn ? 'No content' : '暂无内容'}</div>
  return <div style={{ display: 'grid', gap: 12 }}>{nodes}</div>
}

function collectHeadings(section: GuideSection): Array<{ idx: number; text: string }> {
  const blocks = Array.isArray(section.blocks) ? section.blocks : []
  const out: Array<{ idx: number; text: string }> = []
  for (let i = 0; i < blocks.length; i++) {
    const b: any = blocks[i]
    if (b?.type === 'heading') {
      const t = String(b?.text || '').trim()
      if (t) out.push({ idx: i, text: t })
    }
  }
  return out
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {}
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    ta.style.top = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export default function PublicGuideClient({ token }: { token: string }) {
  const { message } = App.useApp()
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<{ active: boolean; expires_at?: string | null; revoked?: boolean; language?: string | null; version?: string | null } | null>(null)
  const [mode, setMode] = useState<'password' | 'content' | 'invalid'>('password')
  const [password, setPassword] = useState('')
  const [guideSess, setGuideSess] = useState<string>('')
  const [content, setContent] = useState<{ content_json: GuideContent; property_code?: string | null; property_address?: string | null; language?: string | null } | null>(null)
  const [activeTab, setActiveTab] = useState<string>('checkin')
  const [langHint, setLangHint] = useState<string>('')

  async function fetchStatus() {
    const res = await fetch(`${API_BASE}/public/guide/p/${encodeURIComponent(token)}/status`, { cache: 'no-store', credentials: 'include' })
    if (!res.ok) return null
    return res.json().catch(() => null)
  }

  async function fetchContent(sessionId?: string) {
    const sid = String(sessionId ?? guideSess).trim()
    const headers: Record<string, string> = {}
    if (sid) headers['X-Guide-Session'] = sid
    const res = await fetch(`${API_BASE}/public/guide/p/${encodeURIComponent(token)}`, { cache: 'no-store', credentials: 'include', headers })
    if (res.status === 401) return { needPassword: true }
    if (!res.ok) {
      const j = await res.json().catch(() => null)
      throw new Error(String(j?.message || `HTTP ${res.status}`))
    }
    const j = await res.json().catch(() => null)
    return { needPassword: false, data: j }
  }

  async function init() {
    setLoading(true)
    try {
      const st = await fetchStatus()
      if (!st) { setMode('invalid'); setStatus(null); return }
      setStatus(st)
      if (st?.language) setLangHint(String(st.language))
      if (!st.active) { setMode('invalid'); return }
      const c = await fetchContent()
      if (c.needPassword) { setMode('password'); return }
      setContent(c.data)
      if (c?.data?.language) setLangHint(String(c.data.language))
      setMode('content')
    } catch {
      setMode('invalid')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    init()
  }, [token])

  async function submitPassword() {
    const isEnNow = String(langHint || '').trim().toLowerCase().startsWith('en')
    if (!/^\d{4,6}$/.test(password)) { message.error(isEnNow ? 'Please enter 4–6 digits' : '请输入 4–6 位数字'); return }
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/public/guide/p/${encodeURIComponent(token)}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        credentials: 'include',
      })
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        throw new Error(String(j?.message || `HTTP ${res.status}`))
      }
      const j = await res.json().catch(() => null) as any
      const sid = String(j?.session_id || '').trim()
      if (sid) setGuideSess(sid)
      const c = await fetchContent(sid)
      if (c.needPassword) throw new Error('password_required')
      setContent(c.data)
      if (c?.data?.language) setLangHint(String(c.data.language))
      setMode('content')
    } catch (e: any) {
      const msg = String(e?.message || '')
      const isEnNow2 = String(langHint || '').trim().toLowerCase().startsWith('en')
      if (/invalid password/i.test(msg)) message.error(isEnNow2 ? 'Incorrect password' : '密码错误')
      else message.error(isEnNow2 ? 'Verification failed or link expired' : '验证失败或链接已失效')
    } finally {
      setLoading(false)
    }
  }

  const sections = Array.isArray(content?.content_json?.sections) ? content!.content_json!.sections! : []
  const meta: GuideMeta = (content?.content_json as any)?.meta || {}
  const derivedWifi = findWifi(sections)
  const lang = String((content?.language || langHint) || '').trim().toLowerCase()
  const isEn = lang === 'en' || lang.startsWith('en-')
  const pageTitle = isEn ? 'Check-in & Check-out Instructions' : '入住指南'
  const heroTitle = String(meta.title || '').trim() || (content?.property_code ? `${content.property_code} ${pageTitle}` : pageTitle)
  const heroAddr = String(meta.address || '').trim() || String(content?.property_address || '').trim()
  const heroBadge = String(meta.badge || '').trim() || 'PREMIUM STAY'
  const cover = String(meta.cover_image_url || '').trim() || findFirstImage(sections)
  const wifiPwd = String(meta.wifi_password || '').trim() || String(derivedWifi.password || '').trim()
  const wifiLabel = String(meta.wifi_ssid || '').trim() || String(derivedWifi.ssid || '').trim()
  const checkinTime = String(meta.checkin_time || '').trim()
  const checkoutTime = String(meta.checkout_time || '').trim()
  const tabItems = mapTabs(sections, isEn)
  useEffect(() => {
    if (!tabItems.length) return
    if (tabItems.some((x) => x.key === activeTab)) return
    setActiveTab(tabItems[0].key)
  }, [tabItems.length])

  const [pendingScroll, setPendingScroll] = useState<{ tabKey: string; id: string } | null>(null)
  useEffect(() => {
    if (!pendingScroll) return
    if (pendingScroll.tabKey !== activeTab) return
    const id = pendingScroll.id
    setPendingScroll(null)
    requestAnimationFrame(() => {
      const el = document.getElementById(id)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [activeTab, pendingScroll])

  const toc = useMemo(() => {
    const tabs = tabItems.map((t) => ({ key: t.key, label: t.label, headings: collectHeadings(t.section) }))
    const active = tabs.find((t) => t.key === activeTab) || tabs[0]
    return { tabs, active }
  }, [activeTab, tabItems])

  function jumpTo(tabKey: string, id: string) {
    setPendingScroll({ tabKey, id })
    setActiveTab(tabKey)
  }

  const wifiKey = isEn ? 'Wi‑Fi Username' : 'Wi‑Fi 用户名'
  const wifiPwdKey = isEn ? 'Wi‑Fi Password' : 'Wi‑Fi 密码'
  const checkinLabel = isEn ? 'CHECK‑IN TIME' : '入住时间'
  const checkoutLabel = isEn ? 'CHECK‑OUT TIME' : '退房时间'
  const copiedText = isEn ? 'Copied' : '已复制'
  const copyFailedText = isEn ? 'Copy failed' : '复制失败'
  const copyAddressText = isEn ? 'Copy address' : '复制地址'
  const copyWifiPwdText = isEn ? 'Copy Wi‑Fi password' : '复制 Wi‑Fi 密码'
  const copyWifiPwdOkText = isEn ? 'Wi‑Fi password copied' : '复制 Wi‑Fi 密码'

  return (
    <div className={styles.page}>
      <div className={styles.hero}>
        {cover ? <img className={styles.heroImg} src={cover} alt="" /> : null}
        <div className={styles.heroOverlay} />
        <div className={styles.heroContent}>
          <div className={styles.badgeRow}>
            <div className={styles.badge}>{heroBadge}</div>
          </div>
          <div className={styles.title}>{heroTitle}</div>
          {heroAddr ? (
            <div className={styles.addr}>
              <EnvironmentOutlined />
              <span
                onClick={() => {
                  copyText(heroAddr).then((ok) => (ok ? message.success(copiedText) : message.error(copyFailedText)))
                }}
                style={{ cursor: 'pointer' }}
              >
                {heroAddr}
              </span>
              <Tooltip title={copyAddressText}>
                <span
                  onClick={() => {
                    copyText(heroAddr).then((ok) => (ok ? message.success(copiedText) : message.error(copyFailedText)))
                  }}
                  style={{ cursor: 'pointer', opacity: 0.9, display: 'inline-flex', alignItems: 'center' }}
                >
                  <CopyOutlined />
                </span>
              </Tooltip>
            </div>
          ) : null}
        </div>
      </div>

      <div className={styles.container}>
        {loading ? <div style={{ padding: '18px 0' }}><Spin /></div> : null}

        {!loading && mode === 'invalid' ? (
          <div style={{ paddingTop: 18 }}>
            <Alert
              type="error"
              message={isEn ? 'Link expired or not found' : '链接已失效或不存在'}
              description={status?.expires_at ? `expires_at: ${status.expires_at}` : undefined}
            />
          </div>
        ) : null}

        {!loading && mode === 'password' ? (
          <div className={styles.passwordWrap}>
            <Card className={styles.sectionCard}>
              <div className={styles.sectionTitleRow}>
                <span style={{ color: '#ff4d6d' }}><InfoCircleOutlined /></span>
                <div className={styles.sectionTitle}>{isEn ? 'Password' : '验证密码'}</div>
              </div>
              <div className={styles.paragraph} style={{ marginBottom: 10 }}>
                {isEn ? 'Enter the access password (4–6 digits)' : '请输入外链验证密码（4–6 位数字）'}
              </div>
              <Input
                value={password}
                onChange={(e) => setPassword(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
                inputMode="numeric"
                placeholder={isEn ? 'Password' : '密码'}
                style={{ maxWidth: 260 }}
                onPressEnter={submitPassword}
              />
              <div style={{ marginTop: 12 }}>
                <Button type="primary" onClick={submitPassword} disabled={loading}>{isEn ? 'Verify' : '验证并查看'}</Button>
              </div>
            </Card>
          </div>
        ) : null}

        {!loading && mode === 'content' ? (
          <div>
            <div className={styles.tripleCards}>
              <Card className={`${styles.infoCard} ${styles.wifiCard}`} bodyStyle={{ padding: 16 }} styles={{ body: { height: '100%' } as any }}>
                <div className={styles.wifiCardBody}>
                  <div className={styles.infoIcon}><WifiOutlined /></div>
                  <div className={styles.wifiLines}>
                    <div className={styles.infoLabel}>WI‑FI</div>
                    <div className={styles.kvRow}>
                      <div className={styles.kvKey}>{wifiKey}</div>
                      <div className={styles.kvValue}>{wifiLabel || '-'}</div>
                    </div>
                    <div className={styles.kvRow}>
                      <div className={styles.kvKey}>{wifiPwdKey}</div>
                      <div className={styles.copyGroup}>
                        <div
                          className={`${styles.kvValue} ${styles.copyable}`}
                          role="button"
                          tabIndex={0}
                          onClick={() => {
                            if (!wifiPwd) return
                            copyText(wifiPwd).then((ok) => (ok ? message.success(copyWifiPwdOkText) : message.error(copyFailedText)))
                          }}
                          onKeyDown={(e) => {
                            if (!wifiPwd) return
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              copyText(wifiPwd).then((ok) => (ok ? message.success(copyWifiPwdOkText) : message.error(copyFailedText)))
                            }
                          }}
                        >
                          {wifiPwd || '-'}
                        </div>
                        <Tooltip title={copyWifiPwdText}>
                          <Button
                            size="small"
                            icon={<CopyOutlined />}
                            disabled={!wifiPwd}
                            onClick={() => {
                              if (!wifiPwd) return
                              copyText(wifiPwd).then((ok) => (ok ? message.success(copyWifiPwdOkText) : message.error(copyFailedText)))
                            }}
                          />
                        </Tooltip>
                      </div>
                    </div>
                  </div>
                </div>
              </Card>

              <Card className={styles.infoCard} bodyStyle={{ padding: 16 }}>
                <div className={styles.infoCardInner}>
                  <div className={`${styles.infoIcon} ${styles.infoIconOrange}`}><ClockCircleOutlined /></div>
                  <div>
                    <div className={styles.infoLabel}>{checkinLabel}</div>
                    <div className={styles.infoValue}>{checkinTime || '-'}</div>
                  </div>
                </div>
              </Card>

              <Card className={styles.infoCard} bodyStyle={{ padding: 16 }}>
                <div className={styles.infoCardInner}>
                  <div className={`${styles.infoIcon} ${styles.infoIconOrange}`}><ClockCircleOutlined /></div>
                  <div>
                    <div className={styles.infoLabel}>{checkoutLabel}</div>
                    <div className={styles.infoValue}>{checkoutTime || '-'}</div>
                  </div>
                </div>
              </Card>
            </div>

            {toc.tabs.length ? (
              <Card className={styles.tocCard} bodyStyle={{ padding: 16 }}>
                <div className={styles.tocTitleRow}>
                  <span style={{ color: '#ff4d6d' }}><InfoCircleOutlined /></span>
                  <div className={styles.tocTitle}>{isEn ? 'Contents' : '目录'}</div>
                </div>
                <div className={styles.tocGroupLabel} style={{ marginBottom: 10 }}>{isEn ? 'Chapters' : '章节'}</div>
                <div className={styles.tocList}>
                  {toc.tabs.map((t, idx) => (
                    <div
                      key={t.key}
                      role="button"
                      tabIndex={0}
                      className={`${styles.tocItem} ${t.key === activeTab ? styles.tocItemActive : ''}`}
                      onClick={() => jumpTo(t.key, `toc-${t.key}-top`)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          jumpTo(t.key, `toc-${t.key}-top`)
                        }
                      }}
                    >
                      <div className={styles.tocNo}>{idx + 1}</div>
                      <div className={styles.tocItemText}>{t.label}</div>
                      <div className={styles.tocChevron}>›</div>
                    </div>
                  ))}
                </div>
                {toc.active?.headings?.length ? (
                  <div style={{ marginTop: 12 }}>
                    <div className={styles.tocGroupLabel} style={{ marginBottom: 8 }}>{isEn ? 'In this chapter' : '本章小节'}</div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {toc.active.headings.slice(0, 20).map((h) => (
                        <Button key={`${toc.active!.key}-${h.idx}`} size="small" onClick={() => jumpTo(toc.active!.key, `toc-${toc.active!.key}-b-${h.idx}`)}>
                          {h.text}
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </Card>
            ) : null}

            <div className={styles.tabsWrap}>
              <Tabs
                activeKey={activeTab}
                onChange={setActiveTab}
                items={tabItems.map((t) => ({
                  key: t.key,
                  label: (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 800 }}>
                      <span style={{ opacity: 0.75 }}>{t.icon}</span>
                      <span>{t.label}</span>
                    </span>
                  ),
                  children: (
                    <Card className={styles.sectionCard}>
                      <div id={`toc-${t.key}-top`} className={styles.anchor} />
                      {t.section?.title ? <div className={styles.chapterTitle}>{t.section.title}</div> : null}
                      {renderSection(t.section, t.key, isEn)}
                    </Card>
                  ),
                }))}
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
