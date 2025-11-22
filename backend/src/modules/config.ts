import { Router } from 'express'
import { dictionaries } from '../dictionaries'

export const router = Router()

router.get('/dictionaries', (req, res) => {
  res.json(dictionaries)
})