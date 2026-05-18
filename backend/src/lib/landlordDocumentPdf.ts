import { getChromiumBrowser, resetChromiumBrowser } from './playwright'
import { readFileSync } from 'fs'
import path from 'path'

export type LandlordDocumentType = 'agency_authority' | 'property_service_agreement'

export type LandlordDocumentPdfInput = {
  type: LandlordDocumentType
  documentNo?: string
  fields: Record<string, any>
}

export type LandlordDocumentPdfResult = {
  pdf: Buffer
  filename: string
}

function escapeHtml(input: any): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function text(fields: Record<string, any>, key: string, fallback = '') {
  const v = fields?.[key]
  const s = String(v ?? '').trim()
  return s || fallback
}

function phoneText(fields: Record<string, any>, key: string, fallback = '') {
  const s = text(fields, key, fallback)
  if (!s) return ''
  // Guard against accidentally rendering an email address in phone fields.
  if (s.includes('@')) return ''
  return s
}

function formatDateText(value: any) {
  const s = String(value || '').trim()
  if (!s) return ''
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  return s
}

function signatureImage(dataUrl: any) {
  const s = String(dataUrl || '').trim()
  if (!/^data:image\/(png|jpeg|jpg);base64,/i.test(s)) return ''
  return `<img class="sig-image" src="${escapeHtml(s)}" alt="signature" />`
}

function money(fields: Record<string, any>, key: string, fallback = '') {
  const s = text(fields, key, fallback)
  if (!s) return ''
  if (/included|tbc|%/i.test(s)) return s
  if (/^AUD\s*\$/i.test(s)) return s
  if (/^\$/.test(s)) return `AUD ${s}`
  return `AUD $${s}`
}

function row(label: string, value: any) {
  return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value || '')}</td></tr>`
}

function optionalRow(label: string, value: any) {
  const text = String(value || '').trim()
  if (!text) return ''
  return row(label, text)
}

function pairRow(labelA: string, valueA: any, labelB: string, valueB: any) {
  return `<tr><th>${escapeHtml(labelA)}</th><td>${escapeHtml(valueA || '')}</td><th>${escapeHtml(labelB)}</th><td>${escapeHtml(valueB || '')}</td></tr>`
}

function feeRow(label: string, value: any) {
  return `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value || '')}</td></tr>`
}

function englishPropertyType(value: any) {
  const raw = String(value || '').trim()
  const map: Record<string, string> = {
    '一房一卫': '1 Bedroom 1 Bathroom',
    '兩房一衛': '2 Bedrooms 1 Bathroom',
    '两房一卫': '2 Bedrooms 1 Bathroom',
    '兩房兩衛': '2 Bedrooms 2 Bathrooms',
    '两房两卫': '2 Bedrooms 2 Bathrooms',
    '三房兩衛': '3 Bedrooms 2 Bathrooms',
    '三房两卫': '3 Bedrooms 2 Bathrooms',
    '三房三衛': '3 Bedrooms 3 Bathrooms',
    '三房三卫': '3 Bedrooms 3 Bathrooms',
  }
  return map[raw] || raw
}

function englishParking(fields: Record<string, any>) {
  const available = String(fields?.parking_available || '').trim().toLowerCase()
  const raw = String(fields?.parking_details || '').trim()
  if (available === 'no' || /没有|無|无|no parking|none/i.test(raw)) return 'No parking'
  const count = Math.max(1, Number(fields?.parking_count || (raw.match(/\d+/)?.[0]) || 1))
  const notes = String(fields?.parking_space_number || '').trim()
  const normalizedRaw = raw
    .replace(/有[，,]?\s*/g, '')
    .replace(/个停车位/g, 'car space')
    .replace(/個停車位/g, 'car space')
    .replace(/停车位/g, 'car space')
    .replace(/停車位/g, 'car space')
    .trim()
  if (/car space/i.test(normalizedRaw) && !/[固定车位车库机械街边访客其他]/.test(normalizedRaw)) return normalizedRaw
  return [`${count} car space${count > 1 ? 's' : ''}`, notes].filter(Boolean).join(' - ')
}

function englishKeySets(value: any) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/sets?/i.test(raw)) return raw
  return `${raw} Set(s)`
}

function logoDataUri() {
  const candidates = [
    path.resolve(__dirname, '../../../frontend/public/mz-logo.png'),
    path.resolve(process.cwd(), '../frontend/public/mz-logo.png'),
    path.resolve(process.cwd(), 'frontend/public/mz-logo.png'),
  ]
  for (const file of candidates) {
    try {
      const data = readFileSync(file)
      return `data:image/png;base64,${data.toString('base64')}`
    } catch {}
  }
  return ''
}

function baseCss() {
  const logo = logoDataUri()
  return `
    @page { size: A4; margin: 14mm; }
    @page authority { size: A4; margin: 8mm 10mm; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: #111; font-family: Arial, Helvetica, sans-serif; font-size: 11px; line-height: 1.42; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { position: relative; padding-bottom: 10mm; }
    .page-break { break-after: page; page-break-after: always; }
    .content-page { padding-bottom: 0; }
    .brand { font-size: 12px; color: #333; line-height: 1.5; }
    h1 { margin: 0 0 4mm; font-size: 22px; letter-spacing: .4px; text-align: center; }
    h2 { margin: 5mm 0 2mm; font-size: 13px; text-transform: uppercase; border-bottom: 1px solid #222; padding-bottom: 1mm; }
    h3 { margin: 4mm 0 2mm; font-size: 12px; }
    p { margin: 0 0 2.4mm; }
    ul { margin: 1mm 0 0 4.5mm; padding: 0; }
    li { margin: 0 0 1.5mm; }
    table { width: 100%; border-collapse: collapse; }
    th { width: 34%; text-align: left; font-weight: 700; background: #f5f5f5; }
    th, td { border: 1px solid #cfcfcf; padding: 2mm; vertical-align: top; }
    .muted { color: #555; }
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 5mm; }
    .signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 12mm; margin-top: 11mm; }
    .sig-line { border-top: 1px solid #111; padding-top: 2mm; min-height: 15mm; }
    .sig-image { display: block; max-width: 48mm; max-height: 14mm; object-fit: contain; margin: 2mm 0 1mm; }
    .cover-page { border: 1px solid #111; min-height: 248mm; padding: 16mm; display: flex; flex-direction: column; justify-content: center; text-align: center; }
    .cover-logo { width: 38mm; height: 38mm; object-fit: contain; margin: 0 auto 8mm; ${logo ? '' : 'display: none;'} }
    .cover-company { font-size: 18px; font-weight: 700; letter-spacing: .4px; margin-bottom: 3mm; }
    .cover-line { width: 34mm; border-top: 2px solid #111; margin: 0 auto 13mm; }
    .cover-label { font-size: 10px; text-transform: uppercase; letter-spacing: 2.2px; color: #666; margin-bottom: 5mm; }
    .cover-title { font-size: 36px; line-height: 1.05; font-weight: 700; letter-spacing: .2px; margin: 0 0 5mm; }
    .cover-subtitle { font-size: 13px; color: #333; max-width: 120mm; line-height: 1.55; margin: 0 auto 12mm; }
    .document-meta { display: grid; grid-template-columns: 1.1fr 1.6fr 1.1fr; gap: 4mm; margin: 4mm 0 5mm; }
    .document-meta div { border-top: 1px solid #111; padding-top: 2mm; min-height: 15mm; }
    .meta-label { display: block; font-size: 8px; text-transform: uppercase; letter-spacing: 1px; color: #666; margin-bottom: 1mm; }
    .meta-value { font-weight: 700; font-size: 12px; line-height: 1.35; }
    .summary-note { border-top: 2px solid #111; border-bottom: 1px solid #cfcfcf; padding: 3mm 0; margin: 4mm 0; }
    .compact-table th, .compact-table td { padding: 1.7mm 2mm; }
    .footer { position: absolute; bottom: 0; left: 0; right: 0; display: flex; justify-content: space-between; border-top: 1px solid #ddd; padding-top: 2mm; color: #666; font-size: 9px; }
    .authority-page { page: authority; height: calc(297mm - 16mm); padding-bottom: 0; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; }
    .authority-page h1 { margin-bottom: 3.6mm; font-size: 24px; }
    .authority-page h2 { margin: 4.2mm 0 1.2mm; font-size: 14px; padding-bottom: .75mm; }
    .authority-page p { margin-bottom: 2.4mm; font-size: 12.5px; line-height: 1.62; }
    .authority-page ul { margin: 2mm 0 0 5.2mm; }
    .authority-page li { margin-bottom: 2.6mm; font-size: 11.8px; line-height: 1.62; }
    .authority-page th { width: 31%; }
    .authority-page th, .authority-page td { padding: 1.7mm 1.9mm; font-size: 11.5px; }
    .authority-page .pair-table th { width: 18%; }
    .authority-page .pair-table td { width: 32%; }
    .authority-page .muted { font-size: 10.6px; line-height: 1.32; margin-bottom: 1.4mm; }
    .authority-page .authority-bottom { margin-top: 5mm; }
    .authority-page .signatures { display: flex; gap: 10mm; margin-top: 0; }
    .authority-page .sig-line { position: relative; flex: 1 1 0; height: 25mm; padding-top: 1.4mm; font-size: 10.8px; line-height: 1.16; break-inside: avoid; page-break-inside: avoid; overflow: hidden; }
    .authority-page .sig-label { position: absolute; top: 1.4mm; left: 0; right: 0; display: block; font-weight: 700; }
    .authority-page .sig-meta { position: absolute; left: 0; right: 0; bottom: 0; display: flex; justify-content: space-between; gap: 2mm; white-space: nowrap; }
    .authority-page .sig-image { position: absolute; left: 0; top: 5mm; width: 42mm; height: 10mm; object-fit: contain; margin: 0; }
    .authority-page .footer { position: static; font-size: 9px; padding-top: 1mm; margin-top: 2mm; }
  `
}

function renderAgencyAuthority(input: LandlordDocumentPdfInput) {
  const f = input.fields || {}
  const landlordName = text(f, 'landlord_name')
  const landlordEmail = text(f, 'landlord_email')
  const landlordPhone = phoneText(f, 'landlord_phone')
  const propertyAddress = text(f, 'property_address')
  const noticeDays = text(f, 'termination_notice_days', '60')
  const repairLimit = text(f, 'repair_approval_limit', '300')
  const agentName = text(f, 'mz_agent_name', 'Ming Xue')
  const mzPhone = phoneText(f, 'mz_contact_phone', '0434 782 499')
  const mzEmail = text(f, 'mz_contact_email', 'info@mzproperty.com.au')
  const signDate = text(f, 'sign_date')
  const mzSignedName = text(f, 'mz_signed_name', agentName)
  const mzSignedAt = formatDateText(text(f, 'mz_signed_at', signDate))
  const mzSignature = signatureImage(text(f, 'mz_signature_data_url'))
  const landlordSignedName = text(f, 'landlord_signed_name', landlordName)
  const landlordSignedAt = formatDateText(text(f, 'landlord_signed_at', signDate))
  const landlordSignature = signatureImage(text(f, 'landlord_signature_data_url'))

  return `
    <!doctype html>
    <html>
      <head><meta charset="utf-8" /><style>${baseCss()}</style></head>
      <body>
        <section class="page authority-page">
          <div class="authority-main">
            <h1>EXCLUSIVE LEASING &amp; MANAGING AGENCY AUTHORITY</h1>
            <p class="muted">(This Authority should be signed, and a copy retained by the Landlord prior to signing a Residential Tenancy Agreement in respect of the Property)</p>

            <h2>1. Landlord Details</h2>
            <table class="pair-table">
              ${pairRow('Name/s', landlordName, 'Email Address', landlordEmail)}
              ${pairRow('Contact Number', landlordPhone, '', '')}
            </table>

            <h2>2. Agent Details</h2>
            <table class="pair-table">
              ${pairRow('Name/s', 'MZ Property Pty Ltd', 'Agent Name', agentName)}
              ${pairRow('Address', 'G03 /87 Gladstone St, South Melbourne, VIC 3205', 'ABN', '42 657 925 365')}
              ${pairRow('Contact Number', mzPhone, 'Email', mzEmail)}
            </table>

            <h2>3. Property To Be Managed</h2>
            <table>${row('Address', propertyAddress)}</table>

            <h2>4. Termination</h2>
            <p>Either party may terminate this Authority on the giving of not less than <strong>${escapeHtml(noticeDays)}</strong> days written notice to the other.</p>

            <h2>5. Authorisation</h2>
            <p>The Landlord appoints and authorises the Agent to manage, operate and administer the above property for short-term rental and related accommodation purposes, including but not limited to:</p>
            <ul>
              <li>Preparing, listing, advertising and managing the Property on booking platforms, direct booking channels and other marketing channels selected by the Agent.</li>
              <li>Setting nightly rates, availability and booking conditions, communicating with guests, coordinating check-in/check-out, and collecting booking proceeds on behalf of the Landlord.</li>
              <li>Coordinating cleaning, linen, consumables, guest supplies, inspections, routine maintenance, key/access arrangements and property presentation required for short-term rental operation.</li>
              <li>Arranging repairs, maintenance and urgent works, with authority to approve any individual expense up to AUD $${escapeHtml(repairLimit)} without further approval, and liaising with building management, owners corporations, utility providers, councils, contractors and other relevant parties for property-related matters.</li>
            </ul>
          </div>

          <div class="authority-bottom">
            <div class="signatures">
              <div class="sig-line">
                <span class="sig-label">Agent Signature</span>
                ${mzSignature}
                <div class="sig-meta"><span>Name: ${escapeHtml(mzSignedName)}</span><span>Date: ${escapeHtml(mzSignedAt)}</span></div>
              </div>
              <div class="sig-line">
                <span class="sig-label">Landlord Signature</span>
                ${landlordSignature}
                <div class="sig-meta"><span>Name: ${escapeHtml(landlordSignedName)}</span><span>Date: ${escapeHtml(landlordSignedAt)}</span></div>
              </div>
            </div>
            <div class="footer"><span>${escapeHtml(input.documentNo || '')}</span><span>MZ Property Pty Ltd</span></div>
          </div>
        </section>
      </body>
    </html>
  `
}

function renderServiceAgreement(input: LandlordDocumentPdfInput) {
  const f = input.fields || {}
  const ownerName = text(f, 'owner_name')
  const propertyAddress = text(f, 'property_address')
  const companyName = text(f, 'mz_company_name', 'MZ Property Pty Ltd')
  const companyAddress = text(f, 'mz_company_address', 'G03/87 Gladstone St, South Melbourne, VIC 3205')
  const companyAbn = text(f, 'mz_company_abn', '42 657 925 365')
  const contactName = text(f, 'mz_agent_name', 'Ming Xue')
  const contactPhone = text(f, 'mz_contact_phone', '+61 430907988')
  const contactEmail = text(f, 'mz_contact_email', 'info@mzproperty.com.au')
  const commencement = text(f, 'commencement_date')
  const term = text(f, 'term', 'Ongoing with 3-months termination notice')
  const managementFee = text(f, 'management_fee', '50%/Month')
  const propertyType = englishPropertyType(text(f, 'property_type_description'))
  const parking = englishParking(f)
  const keys = englishKeySets(text(f, 'number_of_keys'))
  const mzSignedName = text(f, 'mz_signed_name', contactName)
  const mzSignedAt = formatDateText(text(f, 'mz_signed_at'))
  const mzSignature = signatureImage(text(f, 'mz_signature_data_url'))
  const landlordSignedName = text(f, 'landlord_signed_name', ownerName)
  const landlordSignedAt = formatDateText(text(f, 'landlord_signed_at'))
  const landlordSignature = signatureImage(text(f, 'landlord_signature_data_url'))

  return `
    <!doctype html>
    <html>
      <head><meta charset="utf-8" /><style>${baseCss()}</style></head>
      <body>
        <section class="page page-break">
          <div class="cover-page">
            <img class="cover-logo" src="${logoDataUri()}" />
            <div class="cover-company">${escapeHtml(companyName)}</div>
            <div class="muted">Short-stay property management</div>
            <div class="cover-line"></div>
            <div class="cover-label">Owner Engagement Document</div>
            <div class="cover-title">Service Agreement</div>
            <div class="cover-subtitle">Agreement for short-term rental management services, guest operations, property coordination and owner remittance.</div>
          </div>
        </section>

        <section class="page content-page">
          <h1>MZ PROPERTY Service Agreement</h1>
          <div class="document-meta">
            <div><span class="meta-label">Owner</span><span class="meta-value">${escapeHtml(ownerName || '-')}</span></div>
            <div><span class="meta-label">Property</span><span class="meta-value">${escapeHtml(propertyAddress || '-')}</span></div>
            <div><span class="meta-label">Commencement</span><span class="meta-value">${escapeHtml(commencement || '-')}</span></div>
          </div>
          <div class="summary-note">
            <strong>MZ Contact:</strong> ${escapeHtml(contactName)} · ${escapeHtml(contactPhone)} · ${escapeHtml(contactEmail)}
            <br /><strong>Document No.:</strong> ${escapeHtml(input.documentNo || 'Draft')}
          </div>
          <p>This agreement is made between MZ Property Pty Ltd and the Owner for short-term rental management services for the Property identified above.</p>
          <p>This agreement sets out the terms upon which MZ Property is engaged to manage the Property for the purposes of short-term rentals to Guests.</p>
          <h2>Parties</h2>
          <table class="compact-table">
            ${row('Owner Contact', [text(f, 'owner_phone'), text(f, 'owner_email')].filter(Boolean).join(' / '))}
            ${row('MZ Property', `${companyName}, ABN ${companyAbn}`)}
            ${row('MZ Address', companyAddress)}
          </table>
          <h2>Property Details</h2>
          <table class="compact-table">
            ${row('Utilities', text(f, 'utilities_paid_by', 'paid by Owner'))}
            ${row('Type of Property', propertyType)}
            ${row('Investment or Holiday', text(f, 'investment_or_holiday', 'Investment'))}
            ${row('Parking space', parking)}
            ${row('Number of keys/fobs', keys)}
            ${row('Maximum number of guests', text(f, 'maximum_guests'))}
            ${row('Min. number of nights', text(f, 'minimum_nights'))}
            ${row('Special Instructions', text(f, 'special_instructions'))}
          </table>

          <h2>Bank Details (Owner)</h2>
          <table>
            ${row('Account Name', text(f, 'account_name', ownerName))}
            ${row('BSB', text(f, 'bsb'))}
            ${row('Account Number', text(f, 'account_number'))}
          </table>
          <h2>Commencement Date</h2>
          <ul>
            <li>Commencement Date of Host Services: ${escapeHtml(commencement)}</li>
            <li>Term: ${escapeHtml(term)}</li>
          </ul>
          <h2>Included Services Provided By MZ Property</h2>
          <ul>
            <li>Actively promotes the Property for rental</li>
            <li>Acts on behalf of the owner for all pricing decisions to maximize return</li>
            <li>Creates marketing collateral across various platforms including portals, social media and professional networks</li>
            <li>Compiles, negotiates and executes rental agreements with guests as agent on behalf of the Owner</li>
            <li>Manages housekeeping and cleaning of property</li>
            <li>Provides linen, towels and basic amenities</li>
            <li>Co-ordinates and oversees repair services during a rental term up to a maximum of $500; over this amount, prior authorisation of the Owner is required</li>
            <li>Receives Guests and provides access to the property</li>
            <li>Provides remittance of rent and monthly statements to Owner</li>
            <li>Prepares EOFY report and keeps the owner informed of relevant rules and regulations</li>
          </ul>

          <h2>Owner Fee</h2>
          <table>
            <tr><th>Description</th><th>$(excl. GST)</th></tr>
            ${feeRow('Initial Property Visit', text(f, 'initial_property_visit', 'Included'))}
            ${feeRow('Setup Fee', money(f, 'setup_fee', '$0.00'))}
            ${feeRow('Management Fee (% of booking value)', managementFee)}
            ${feeRow('Consumable Fee', money(f, 'consumable_fee', '0.00 /Month'))}
            ${feeRow('Bed Linen, towels and guest amenities', text(f, 'linen_fee', 'Included'))}
            ${feeRow('Initial housekeeping service and linen', text(f, 'initial_housekeeping_fee', 'TBC'))}
            ${feeRow('Installation Fee', money(f, 'installation_fee', '$0.00'))}
            ${feeRow('Purchase Fee', money(f, 'purchase_fee', '$0.00'))}
            ${feeRow('Photography', money(f, 'photography_fee', '$0.00'))}
          </table>
          <h2>Payment Terms</h2>
          <ul>
            <li>The initial housekeeping and home setup charges are deducted from the first booking revenue.</li>
            <li>The management fee is deducted from the generated revenue.</li>
            <li>All rental income received less any fees due to MZ Property will be transferred to the Owner's bank account once a month within the first 6 business days of the following month.</li>
          </ul>

          <h2>Accepted and Agreed</h2>
          <div class="signatures">
            <div class="sig-line"><strong>${escapeHtml(companyName)}</strong><br />Name: ${escapeHtml(mzSignedName)}<br />Title: General Manager<br /><br />Signature:<br />${mzSignature}<br />Date: ${escapeHtml(mzSignedAt)}</div>
            <div class="sig-line"><strong>Owner</strong><br />Name: ${escapeHtml(landlordSignedName)}<br />Title: Owner<br /><br />Signature:<br />${landlordSignature}<br />Date: ${escapeHtml(landlordSignedAt)}</div>
          </div>
          <h2>Special Conditions</h2>
          <h3>1. Essential Items</h3>
          <p>Every property needs to be equipped with minimum guest expectation items and services including WIFI, kettle, hair dryer, iron/ironing board, toaster, coffee maker, heater and cooling/fan equipment. Missing items may be placed during provisioning and charged to the homeowner.</p>
          <h3>2. Exclusivity Period of Agency</h3>
          <p>The Host appoints MZ Property as its exclusive provider of rental management services from the Commencement Date and for the Term of the Engagement.</p>
          <h3>3. Agency Appointment</h3>
          <p>MZ Property shall be considered an agent on behalf of the Host, with authority to enter the Property, agree terms of rent and manage the rental. Urgent repair expenses incurred to make the Property safe or meet the description of the Property are reimbursable to MZ Property.</p>
          <h3>4. Insurance</h3>
          <p>The Host is responsible for obtaining and paying for general liability insurance and other insurances to protect the Host, MZ Property and Guests.</p>

          <h3>5. Compliance</h3>
          <p>The Host is responsible for ensuring that the Property and amenities meet local, State and Federal legislation, by-laws, orders and notices relating to use of the Property as a rental property.</p>
          <h3>6. Repairs and Maintenance</h3>
          <p>The Host shall ensure that the Property and basic amenities are provided and maintained as advertised on handover. Malfunctions, failures or damage must be repaired as soon as possible.</p>
          <h3>7. Notice</h3>
          <p>It is the Owner's responsibility to give notice of property availability dates, personal use or changes made to the Property. At least 5 business days' notice must be given to MZ Property.</p>
          <h3>8. Cancellation Policy</h3>
          <p>If the Host breaches the Agreement or Terms and Conditions after MZ Property has undertaken listing, photography, preparation consultancy or other services, a compensation fee of AUD $500 will be payable by the Host to MZ Property.</p>
          <h3>9. Termination</h3>
          <p>This Agreement remains in force ongoing from the Commencement Date unless terminated earlier by either Party. Either Party may terminate this Agreement on delivery of 3 months' prior written notice to the other Party.</p>
          <h3>10. Rental Income Remittance</h3>
          <p>All rental income received less any fees due to MZ Property as per this agreement will be transferred to the Host's bank account once a month within the first 6 business days of the following month.</p>
        </section>
      </body>
    </html>
  `
}

function isPlaywrightClosedError(e: any) {
  return /(Target page, context or browser has been closed|browser has been closed|browser disconnected|Target closed)/i.test(String(e?.message || ''))
}

export function renderLandlordDocumentHtml(input: LandlordDocumentPdfInput) {
  return input.type === 'agency_authority' ? renderAgencyAuthority(input) : renderServiceAgreement(input)
}

export async function generateLandlordDocumentPdf(input: LandlordDocumentPdfInput): Promise<LandlordDocumentPdfResult> {
  const html = renderLandlordDocumentHtml(input)
  const runOnce = async () => {
    let browser = await getChromiumBrowser()
    let context: any = null
    try {
      try {
        context = await browser.newContext()
      } catch (e: any) {
        if (!isPlaywrightClosedError(e)) throw e
        await resetChromiumBrowser()
        browser = await getChromiumBrowser()
        context = await browser.newContext()
      }
      const page = await context.newPage()
      page.setDefaultTimeout(45000)
      page.setDefaultNavigationTimeout(45000)
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 45000 } as any)
      await page.evaluate(() => (document as any).fonts?.ready).catch(() => {})
      await page.emulateMedia({ media: 'print' } as any)
      const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true })
      try { await page.close() } catch {}
      return Buffer.from(pdf)
    } finally {
      try { await context?.close?.() } catch {}
    }
  }
  let pdf: Buffer
  try {
    pdf = await runOnce()
  } catch (e: any) {
    if (!isPlaywrightClosedError(e)) throw e
    await resetChromiumBrowser()
    pdf = await runOnce()
  }
  const prefix = input.type === 'agency_authority' ? 'agency-authority' : 'service-agreement'
  const no = String(input.documentNo || Date.now()).replace(/[^a-zA-Z0-9._-]+/g, '-')
  return { pdf, filename: `${prefix}-${no}.pdf` }
}
