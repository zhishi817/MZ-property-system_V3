import { Router } from 'express'
import { login, me, setDeletePassword } from '../auth'

export const router = Router()

router.post('/login', login)
router.get('/me', me)
router.post('/delete-password', setDeletePassword)