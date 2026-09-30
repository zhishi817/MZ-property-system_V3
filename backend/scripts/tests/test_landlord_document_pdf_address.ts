import assert from 'node:assert/strict'
import {
  AGENCY_AUTHORITY_COMPANY_ADDRESS,
  renderLandlordDocumentHtml,
} from '../../src/lib/landlordDocumentPdf'

const previousAddress = 'G03 /87 Gladstone St, South Melbourne, VIC 3205'

const authorityHtml = renderLandlordDocumentHtml({
  type: 'agency_authority',
  documentNo: 'AA-ADDRESS-TEST',
  fields: {
    mz_company_address: previousAddress,
  },
})

assert.ok(authorityHtml.includes(AGENCY_AUTHORITY_COMPANY_ADDRESS), 'agency authority should render the new office address')
assert.ok(!authorityHtml.includes(previousAddress), 'agency authority should not render the previous office address')

const serviceAgreementHtml = renderLandlordDocumentHtml({
  type: 'property_service_agreement',
  documentNo: 'SA-ADDRESS-TEST',
  fields: {
    mz_company_address: previousAddress,
  },
})

assert.ok(serviceAgreementHtml.includes(previousAddress), 'service agreement address should remain unchanged')
assert.ok(!serviceAgreementHtml.includes(AGENCY_AUTHORITY_COMPANY_ADDRESS), 'service agreement should not inherit the authority-only address')

console.log('landlord document PDF address contract: passed')
