import type { Metadata } from 'next'
import OurStoryPage from './OurStoryPage'

export const metadata: Metadata = {
  title: 'Our Story | MZ Property',
  description: 'From a small Southbank beginning to caring for properties across Melbourne — the story behind MZ Property.',
}

export default function Page() {
  return <OurStoryPage />
}
