import type { Metadata } from 'next'
import ContactPage from './ContactPage'

export const metadata: Metadata = {
  title: 'Contact Us | MZ Property',
  description: 'Contact MZ Property about a stay, an existing booking or property management.',
}

export default function Page() {
  return <ContactPage />
}
