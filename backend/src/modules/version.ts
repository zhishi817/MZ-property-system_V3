import { Router } from 'express'
import { appVersion, buildTimestamp, commitRef } from '../version'

export const router = Router()

router.get('/', (_req, res) => {
  res.json({ version: appVersion, buildTimestamp, commit: commitRef })
})

