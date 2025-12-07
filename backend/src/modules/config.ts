import { Router } from 'express'
import { dictionaries } from '../dictionaries'
import { requirePerm } from '../auth'

export const router = Router()

router.get('/dictionaries', (req, res) => {
  res.json(dictionaries)
})

const invoiceConfig: any = {
  company_name: process.env.INVOICE_COMPANY_NAME || 'Homixa Service Pty Ltd',
  company_phone: process.env.INVOICE_COMPANY_PHONE || '043260187',
  company_abn: process.env.INVOICE_COMPANY_ABN || '30666510863',
  logo_path: process.env.INVOICE_LOGO_PATH || '/company-logo.png',
  tax_rate: Number(process.env.INVOICE_TAX_RATE || '0.10'),
  pay_account_name: process.env.INVOICE_ACCOUNT_NAME || 'Homixa Service Pty Ltd',
  pay_bsb: process.env.INVOICE_BSB || '062 692',
  pay_account_no: process.env.INVOICE_ACCOUNT || '7600 0572',
}

router.get('/invoice', (req, res) => {
  res.json(invoiceConfig)
})

router.patch('/invoice', requirePerm('rbac.manage'), (req, res) => {
  const body = req.body || {}
  const allowed = ['company_name','company_phone','company_abn','logo_path','tax_rate','pay_account_name','pay_bsb','pay_account_no']
  for (const k of allowed) {
    if (body[k] !== undefined) invoiceConfig[k] = k === 'tax_rate' ? Number(body[k]) : String(body[k])
  }
  return res.json(invoiceConfig)
})