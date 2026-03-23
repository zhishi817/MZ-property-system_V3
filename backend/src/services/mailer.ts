type MailPayload = { to: string; subject: string; html?: string; text?: string }

let cachedTransport: any = null
let cachedKey = ''

function boolEnv(v: string) {
  const s = String(v || '').trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes'
}

function buildTransport() {
  const host = String(process.env.SMTP_HOST || '').trim()
  const port = Number(process.env.SMTP_PORT || 587)
  const user = String(process.env.SMTP_USER || '').trim()
  const pass = String(process.env.SMTP_PASS || '').trim()
  const secure = boolEnv(String(process.env.SMTP_SECURE || (port === 465 ? 'true' : 'false')))

  if (!host || !user || !pass) throw new Error('missing_smtp_config')

  const key = JSON.stringify({ host, port, user, secure })
  if (cachedTransport && cachedKey === key) return cachedTransport

  const nodemailer = require('nodemailer')
  cachedTransport = nodemailer.createTransport({ host, port, secure, auth: { user, pass } })
  cachedKey = key
  return cachedTransport
}

export async function sendMail(payload: MailPayload) {
  const from = String(process.env.SMTP_FROM || process.env.SMTP_USER || '').trim()
  if (!from) throw new Error('missing_smtp_from')
  const transporter = buildTransport()
  await transporter.sendMail({ from, to: payload.to, subject: payload.subject, html: payload.html, text: payload.text })
}

