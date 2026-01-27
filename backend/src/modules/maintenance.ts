import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { hasR2, r2Upload } from '../r2'
import { requireAnyPerm } from '../auth'

export const router = Router()
const upload = multer({ storage: multer.memoryStorage() })

router.post('/upload', requireAnyPerm(['property.write','rbac.manage']), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    if (!hasR2 || !(req.file as any).buffer) {
      return res.status(500).json({ message: 'R2 not configured' })
    }
    const ext = path.extname(req.file.originalname) || ''
    const key = `maintenance/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
    const url = await r2Upload(key, req.file.mimetype || 'application/octet-stream', (req.file as any).buffer)
    return res.status(201).json({ url })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload failed' })
  }
})

export default router
