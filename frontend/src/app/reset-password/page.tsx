import { Suspense } from 'react'
import ResetPasswordInner from './ResetPasswordInner'

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordInner />
    </Suspense>
  )
}
