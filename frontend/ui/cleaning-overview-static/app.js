function el(tag, attrs, children) {
  const node = document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = String(v)
      else if (k === 'text') node.textContent = String(v)
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v)
      else node.setAttribute(k, String(v))
    }
  }
  const arr = Array.isArray(children) ? children : (children != null ? [children] : [])
  for (const ch of arr) {
    if (ch == null) continue
    if (typeof ch === 'string') node.appendChild(document.createTextNode(ch))
    else node.appendChild(ch)
  }
  return node
}

function drawChart(canvas) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)

  const padding = { l: 56, r: 18, t: 18, b: 42 }
  const plotW = w - padding.l - padding.r
  const plotH = h - padding.t - padding.b

  const data = [
    { d: '2026-02-17', out: 17, in: 17 },
    { d: '2026-02-18', out: 23, in: 25 },
    { d: '2026-02-19', out: 17, in: 18 },
    { d: '2026-02-20', out: 24, in: 25 },
    { d: '2026-02-21', out: 22, in: 25 },
    { d: '2026-02-22', out: 28, in: 16 },
    { d: '2026-02-23', out: 26, in: 8 },
  ]
  const maxV = Math.max(...data.flatMap((x) => [x.out, x.in]), 0)
  const yMax = maxV <= 0 ? 1 : Math.ceil(maxV / 7) * 7

  ctx.strokeStyle = '#eef2ff'
  ctx.lineWidth = 1
  ctx.setLineDash([2, 4])
  const ticks = [0, 7, 14, 21, 28].filter((v) => v <= yMax)
  for (const v of ticks) {
    const y = padding.t + plotH - (v / yMax) * plotH
    ctx.beginPath()
    ctx.moveTo(padding.l, y)
    ctx.lineTo(padding.l + plotW, y)
    ctx.stroke()

    ctx.setLineDash([])
    ctx.fillStyle = '#94a3b8'
    ctx.font = '600 12px ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(v), padding.l - 10, y)
    ctx.setLineDash([2, 4])
  }
  ctx.setLineDash([])

  const groups = data.length
  const groupW = plotW / groups
  const barW = Math.max(18, Math.min(34, groupW * 0.22))
  const gap = Math.max(10, Math.min(18, groupW * 0.14))
  for (let i = 0; i < groups; i++) {
    const gx = padding.l + i * groupW + groupW / 2
    const outH = (data[i].out / yMax) * plotH
    const inH = (data[i].in / yMax) * plotH
    const y0 = padding.t + plotH

    ctx.fillStyle = '#3b82f6'
    ctx.beginPath()
    ctx.roundRect(gx - gap / 2 - barW, y0 - outH, barW, outH, 4)
    ctx.fill()

    ctx.fillStyle = '#f97316'
    ctx.beginPath()
    ctx.roundRect(gx + gap / 2, y0 - inH, barW, inH, 4)
    ctx.fill()

    ctx.fillStyle = '#94a3b8'
    ctx.font = '600 12px ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(data[i].d, gx, padding.t + plotH + 14)
  }
}

function renderTasks() {
  const rows = [
    {
      title: '送电饭煲',
      date: '2026-02-16',
      kind: '其他',
      assignee: 'Alice',
      propertyId: '3805410',
      urgency: '低',
      status: '已完成',
    },
  ]
  const body = document.getElementById('tasksBody')
  if (!body) return
  body.innerHTML = ''
  for (const r of rows) {
    const row = el('div', { class: 'table-row', role: 'row' }, [
      el('div', { class: 'cell', role: 'cell' }, [
        el('div', { class: 'task-info' }, [
          el('div', { class: 'badge-icon', 'aria-hidden': 'true', text: '🕒' }),
          el('div', { class: 'task-meta' }, [
            el('div', { class: 'task-title', text: r.title }),
            el('div', { class: 'task-sub' }, [
              el('span', { text: r.date }),
              el('span', { class: 'pill', text: r.kind }),
            ]),
          ]),
        ]),
      ]),
      el('div', { class: 'cell', role: 'cell' }, [
        el('span', { class: 'pill', text: r.assignee }),
      ]),
      el('div', { class: 'cell', role: 'cell' }, [el('span', { text: r.propertyId })]),
      el('div', { class: 'cell', role: 'cell' }, [el('span', { class: 'pill low', text: r.urgency })]),
      el('div', { class: 'cell', role: 'cell' }, [el('span', { class: 'pill done', text: r.status })]),
      el('div', { class: 'cell', role: 'cell' }, [
        el('div', { class: 'ops' }, [
          el('button', { class: 'icon-btn', type: 'button', 'aria-label': '查看', text: '👁' }),
          el('button', { class: 'icon-btn', type: 'button', 'aria-label': '编辑', text: '✎' }),
          el('button', { class: 'icon-btn', type: 'button', 'aria-label': '删除', text: '🗑' }),
        ]),
      ]),
    ])
    body.appendChild(row)
  }
}

function init() {
  const run = () => {
    const canvas = document.getElementById('trendChart')
    if (canvas instanceof HTMLCanvasElement) drawChart(canvas)
    renderTasks()
    const btn = document.getElementById('createTaskBtn')
    if (btn) btn.addEventListener('click', () => {})
    window.__CLEANING_OVERVIEW_READY__ = true
  }
  try {
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(run).catch(run)
      return
    }
  } catch {}
  run()
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
else init()
