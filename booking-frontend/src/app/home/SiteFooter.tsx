import type { HomepageContent } from '../../lib/homepage'
import s from './home.module.css'

type FooterContent = Pick<HomepageContent, 'contactEmail' | 'contactPhone' | 'contactWhatsapp' | 'contactAddress'>

export default function SiteFooter({ content, footerLabel = 'Website implementation candidate' }: { content: FooterContent; footerLabel?: string }) {
  return (
    <footer className={s.siteFooter}>
      <div className={s.footerGrid}>
        <a className={s.footerBrand} href="/" aria-label="MZ Property home"><img src="/homepage/brand-source.png" alt="MZ Property" /></a>
        <div><h2>Socials</h2><a href="https://www.facebook.com/mzpropertymelbourne" target="_blank" rel="noreferrer">Facebook</a><a href="https://www.youtube.com/@MZProperty" target="_blank" rel="noreferrer">YouTube</a><a href="https://www.instagram.com/mzproperty.melbourne/" target="_blank" rel="noreferrer">Instagram</a></div>
        <div><h2>Menu</h2><a href="/#home">Home</a><a href="/properties">All Properties</a><a href="/our-story">Our Story</a><a href="/#testimonials">Reviews</a><a href="/contact">Contact us</a></div>
        <div><h2>Info</h2><a href={`mailto:${content.contactEmail}`}>{content.contactEmail}</a><a href={`tel:${content.contactPhone.replace(/[^+\d]/g, '')}`}>Tel: {content.contactPhone}</a>{content.contactWhatsapp ? <a href={`https://wa.me/${content.contactWhatsapp.replace(/\D/g, '')}`} target="_blank" rel="noreferrer">WhatsApp</a> : null}<address>{content.contactAddress}</address></div>
        <div><h2>Legal</h2><span>Terms &amp; Conditions — coming soon</span><span>Privacy Policy — coming soon</span></div>
      </div>
      <div className={s.footerBottom}><span>© 2026 MZ Property Pty Ltd</span><span>{footerLabel}</span></div>
    </footer>
  )
}
