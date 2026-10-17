const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

function loadTypeScriptModule(relativePath, replacements = {}) {
  const filename = path.resolve(__dirname, '..', relativePath)
  const source = fs.readFileSync(filename, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText
  const module = { exports: {} }
  const localRequire = (request) => Object.prototype.hasOwnProperty.call(replacements, request) ? replacements[request] : require(request)
  Function('module', 'exports', 'require', 'process', output)(module, module.exports, localRequire, process)
  return module.exports
}

const homepage = loadTypeScriptModule('src/lib/homepage.ts')
const carousel = loadTypeScriptModule('src/lib/carouselMath.ts')
const homepageServer = loadTypeScriptModule('src/lib/homepageServer.ts', {
  './homepage': homepage,
  './serverApi': {
    loadGuestSiteConfig: async () => { throw new Error('unexpected live config read') },
    loadGuestSiteProperties: async () => { throw new Error('unexpected live property read') },
  },
})

test('homepage property feed exposes only explicitly published public fields', () => {
  const rows = homepage.sanitizeHomepagePropertyFeed({ properties: [
    {
      id: 'stay-1',
      is_published: true,
      hero_title: 'City stay',
      public_region_label: 'Melbourne CBD',
      hero_image_url: 'https://images.example/stay.jpg',
      bedroom_count: 2,
      bathroom_count: 1,
      internal_owner_note: 'must never escape',
      nightly_cost: 999,
    },
    { id: 'draft', is_published: false, hero_title: 'Draft listing' },
  ] })
  assert.equal(rows.length, 1)
  assert.deepEqual(Object.keys(rows[0]).sort(), ['bathrooms', 'bedrooms', 'detailHref', 'id', 'imageUrl', 'region', 'title'])
  assert.equal(rows[0].detailHref, '/properties/stay-1')
  assert.equal('internal_owner_note' in rows[0], false)
})

test('homepage property feed respects published sort order and distinguishes ready from empty', () => {
  const payload = [
    { id: 'third', is_published: true, sort_order: 30, hero_title: 'Third' },
    { id: 'draft', is_published: false, sort_order: 0, hero_title: 'Draft' },
    { id: 'first', is_published: true, sort_order: 10, hero_title: 'First' },
    { id: 'second', is_published: true, sort_order: 20, hero_title: 'Second' },
    { id: 'fourth', is_published: true, sort_order: 40, hero_title: 'Fourth' },
  ]
  assert.deepEqual(homepage.homepagePropertyFeedFromPayload(payload).properties.map((property) => property.id), ['first', 'second', 'third'])
  assert.deepEqual(homepage.homepagePropertyFeedFromPayload([]), { status: 'empty', properties: [] })
})

test('homepage CMS mapping preserves approved Mission/address fallbacks and uses valid configured fields', () => {
  const configured = homepage.homepageContentFromPayload({
    banner_title: 'Configured homepage title',
    banner_subtitle: 'Configured homepage subtitle',
    hero_background_urls: ['/uploads/hero-one.jpg', 'javascript:alert(1)', 'https://images.example/hero-two.jpg'],
    brand_story: 'Configured public brand story.',
    contact_email: 'HELLO@EXAMPLE.COM',
    contact_phone: '+61 400 000 000',
    contact_whatsapp: '+61 411 111 111',
    contact_address: '130 Example St, Melbourne VIC',
  })
  assert.equal(configured.status, 'ready')
  assert.equal(configured.content.heroTitle, 'Configured homepage title')
  assert.deepEqual(configured.content.heroImages, ['/uploads/hero-one.jpg', 'https://images.example/hero-two.jpg'])
  assert.equal(configured.content.contactEmail, 'hello@example.com')
  assert.equal(configured.content.missionOwner, homepage.DEFAULT_HOMEPAGE_CONTENT.missionOwner)
  assert.equal(configured.content.missionGuest, homepage.DEFAULT_HOMEPAGE_CONTENT.missionGuest)

  const legacy = homepage.homepageContentFromPayload({
    banner_title: '安心入住墨尔本',
    banner_subtitle: '精选短租房源，适合商务出行、家庭入住和长期停留。',
    brand_story: 'MZ Property 提供真实房源、清晰沟通和本地化服务，让客人在预订前就知道自己会住进什么样的空间。',
    contact_address: '87 Gladstone St, South Melbourne, VIC 3205',
  })
  assert.equal(legacy.status, 'fallback')
  assert.deepEqual(legacy.content, homepage.DEFAULT_HOMEPAGE_CONTENT)
  assert.equal(homepage.homepageContentFromPayload(null, 'error').status, 'error')
})

test('homepage server adapters expose success, empty, failure and safe fallback contracts', async () => {
  const success = await homepageServer.loadHomepagePropertyFeed({
    loadProperties: async () => [{ id: 'stay-1', is_published: true, sort_order: 1, hero_title: 'Published stay' }],
  })
  assert.equal(success.status, 'ready')
  assert.equal(success.properties[0].id, 'stay-1')
  assert.equal((await homepageServer.loadHomepagePropertyFeed({ loadProperties: async () => [] })).status, 'empty')
  assert.equal((await homepageServer.loadHomepagePropertyFeed({ loadProperties: async () => { throw new Error('offline') } })).status, 'error')

  const content = await homepageServer.loadHomepageContent({ loadConfig: async () => ({ banner_title: 'CMS title' }) })
  assert.equal(content.status, 'ready')
  assert.equal(content.content.heroTitle, 'CMS title')
  const fallback = await homepageServer.loadHomepageContent({ loadConfig: async () => { throw new Error('offline') } })
  assert.equal(fallback.status, 'error')
  assert.equal(fallback.content.heroTitle, homepage.DEFAULT_HOMEPAGE_CONTENT.heroTitle)
})

test('homepage contact validation and normalization keep backend limits aligned', () => {
  assert.deepEqual(homepage.validateHomepageContact({ firstName: '', lastName: '', email: 'bad', message: '' }), {
    firstName: 'Enter your first name.',
    lastName: 'Enter your last name.',
    email: 'Enter a valid email address.',
    message: 'Tell us how we can help.',
  })
  assert.deepEqual(homepage.normalizeHomepageContact({
    firstName: ' Ada ', lastName: ' Lovelace ', email: ' ADA@EXAMPLE.COM ', message: ' Hello ',
  }), {
    firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', message: 'Hello',
  })
})

test('homepage search uses Melbourne calendar dates and rejects invalid stay ranges', () => {
  assert.equal(homepage.melbourneTodayISO(new Date('2026-01-01T13:30:00.000Z')), '2026-01-02')
  assert.equal(homepage.addIsoCalendarDays('2026-02-28', 1), '2026-03-01')
  assert.equal(homepage.addIsoCalendarDays('2026-12-31', 1), '2027-01-01')
  assert.equal(homepage.formatHomepageStayDate('2026-10-14'), '14 Oct 2026')
  assert.equal(homepage.formatHomepageStayDate(''), 'Select date')
  assert.deepEqual(homepage.validateHomepageSearch({
    area: 'docklands', checkin: '2026-10-02', checkout: '2026-10-02', guests: '9',
  }, '2026-10-01'), {
    checkout: 'Check-out must be after check-in.',
    guests: 'Choose between 1 and 8 guests.',
  })
  assert.deepEqual(homepage.validateHomepageSearch({
    area: 'all-melbourne', checkin: '2026-09-30', checkout: '2026-10-02', guests: '2',
  }, '2026-10-01'), {
    checkin: 'Check-in cannot be before today in Melbourne.',
  })
})

test('years in business changes only at the Melbourne October anniversary month', () => {
  assert.equal(homepage.mzYearsInBusiness(new Date('2026-09-15T02:00:00.000Z')), 7)
  assert.equal(homepage.mzYearsInBusiness(new Date('2026-10-01T00:00:00.000Z')), 8)
  assert.equal(homepage.mzYearsInBusiness(new Date('2027-01-01T00:00:00.000Z')), 8)
  assert.equal(homepage.mzYearsInBusiness(new Date('2027-09-30T13:30:00.000Z')), 8)
  assert.equal(homepage.mzYearsInBusiness(new Date('2027-09-30T14:30:00.000Z')), 9)
})

test('homepage business stats accept only a bounded aggregate and keep the approved fallback explicit', () => {
  assert.equal(homepage.HOMEPAGE_PROPERTIES_MANAGED_FALLBACK_COUNT, 121)
  assert.equal(homepage.HOMEPAGE_MANAGED_COUNT_SOURCE_ENV, 'HOMEPAGE_MANAGED_COUNT_SOURCE')
  assert.equal(homepage.homepageManagedCountSourceEnabled(undefined), false)
  assert.equal(homepage.homepageManagedCountSourceEnabled('development'), false)
  assert.equal(homepage.homepageManagedCountSourceEnabled('guest-site'), true)
  assert.deepEqual(homepage.sanitizeHomepageBusinessStats({
    properties_managed_to_date: 121,
    as_of: '2026-10-01T00:00:00.000Z',
    internal_rows: [{ address: 'must not be used' }],
  }), {
    propertiesManagedToDate: 121,
    asOf: '2026-10-01T00:00:00.000Z',
  })
  assert.deepEqual(homepage.sanitizeHomepageBusinessStats(null), { propertiesManagedToDate: null, asOf: '' })
  assert.deepEqual(homepage.sanitizeHomepageBusinessStats({ properties_managed_to_date: 'not-a-count' }), { propertiesManagedToDate: null, asOf: '' })
})

test('homepage search query normalization preserves only supported placeholder fields', () => {
  const normalized = homepage.homepageSearchFromQuery({
    area: 'unknown-area', checkin: ['2026-10-05', 'ignored'], checkout: '2026-10-08', guests: '3', unexpected: 'secret',
  })
  assert.deepEqual(normalized, { area: 'all-melbourne', checkin: '2026-10-05', checkout: '2026-10-08', guests: '3' })
  assert.equal(homepage.homepageSearchQuery(normalized), 'area=all-melbourne&checkin=2026-10-05&checkout=2026-10-08&guests=3')
})

test('testimonial swipe accepts a short fast flick and rebounds a short slow drag', () => {
  const fast = carousel.decideTestimonialSwipe({ deltaX: -25, deltaY: 1, velocityX: -0.19, viewportWidth: 390, horizontalLocked: true })
  assert.equal(fast.commit, true)
  assert.equal(fast.direction, 1)
  const slow = carousel.decideTestimonialSwipe({ deltaX: -25, deltaY: 1, velocityX: -0.08, viewportWidth: 390, horizontalLocked: true })
  assert.equal(slow.commit, false)
  const vertical = carousel.decideTestimonialSwipe({ deltaX: -70, deltaY: 120, velocityX: -0.8, viewportWidth: 390, horizontalLocked: false })
  assert.equal(vertical.commit, false)
})

test('contact form keeps a stable submission id and only clears after durable success', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/app/home/ContactForm.tsx'), 'utf8')
  assert.match(source, /submissionIdRef\.current \|\| window\.crypto\.randomUUID\(\)/)
  assert.match(source, /if \(!response\?\.ok \|\| !response\.id\) throw/)
  assert.ok(source.indexOf('setValues(EMPTY_FORM)') > source.indexOf('if (!response?.ok || !response.id)'))
  assert.match(source, /Your details are still in the form, so you can try again/)
  const catchBlock = source.match(/catch \{([\s\S]*?)\n\s*\} finally/)
  assert.ok(catchBlock, 'contact form should have an explicit failure branch')
  assert.doesNotMatch(catchBlock[1], /setValues\(EMPTY_FORM\)/)
})

test('homepage branding uses a square favicon and the current footer address', () => {
  const layoutSource = fs.readFileSync(path.resolve(__dirname, '../src/app/layout.tsx'), 'utf8')
  const homeSource = fs.readFileSync(path.resolve(__dirname, '../src/app/home/HomePage.tsx'), 'utf8')
  const footerSource = fs.readFileSync(path.resolve(__dirname, '../src/app/home/SiteFooter.tsx'), 'utf8')
  const homepageSource = fs.readFileSync(path.resolve(__dirname, '../src/lib/homepage.ts'), 'utf8')
  const stylesSource = fs.readFileSync(path.resolve(__dirname, '../src/app/home/home.module.css'), 'utf8')
  assert.match(layoutSource, /\/homepage\/mz-mark-v2\.svg\?v=20261017-1/)
  assert.doesNotMatch(layoutSource, /icons:\s*\{\s*icon:\s*['"]\/homepage\/brand-source\.png/)
  assert.match(homeSource, /<SiteFooter content=\{content\}/)
  assert.match(footerSource, /content\.contactAddress/)
  assert.match(homepageSource, /130 Gladstone St, South Melbourne, VIC 3205/)
  assert.doesNotMatch(homepageSource, /contactAddress:\s*['"]87 Gladstone St, South Melbourne/)
  assert.match(stylesSource, /filter:invert\(1\) grayscale\(1\) brightness\(1\.35\)/)
  assert.doesNotMatch(stylesSource, /footerBrand img\{filter:brightness\(0\) invert\(1\)/)
})

test('Our Story is a real shared-navigation route with approved factual copy', () => {
  const headerSource = fs.readFileSync(path.resolve(__dirname, '../src/app/home/HomeHeader.tsx'), 'utf8')
  const navigationSource = fs.readFileSync(path.resolve(__dirname, '../src/app/home/siteNavigation.ts'), 'utf8')
  const footerSource = fs.readFileSync(path.resolve(__dirname, '../src/app/home/SiteFooter.tsx'), 'utf8')
  const homeSource = fs.readFileSync(path.resolve(__dirname, '../src/app/home/HomePage.tsx'), 'utf8')
  const storySource = fs.readFileSync(path.resolve(__dirname, '../src/app/our-story/OurStoryPage.tsx'), 'utf8')
  const propertySource = fs.readFileSync(path.resolve(__dirname, '../src/app/properties/[id]/PropertyDetailClient.tsx'), 'utf8')

  for (const source of [navigationSource, footerSource]) assert.match(source, /['"]\/our-story['"]/)
  assert.match(navigationSource, /['"]\/properties['"]/)
  assert.match(navigationSource, /All Properties/)
  assert.match(navigationSource, /['"]\/#testimonials['"]/)
  assert.match(navigationSource, /['"]\/contact['"]/)
  assert.match(headerSource, /SITE_NAV_ITEMS/)
  assert.match(propertySource, /SITE_NAV_ITEMS/)
  assert.match(homeSource, /href="\/our-story">Read our story/)
  assert.match(storySource, /In 2018, after selling his fish and chip shop in Melbourne/)
  assert.match(storySource, /Built one property/)
  assert.doesNotMatch(storySource, /Built one home/)
  assert.match(storySource, /approximately 120 properties/)
  assert.match(storySource, /every three months/)
  assert.match(storySource, /no single review or process can guarantee a particular result/)
  assert.doesNotMatch(storySource, /These are the working practices described by our team/)
  assert.equal((storySource.match(/<StoryImage/g) || []).length, 4)
  assert.doesNotMatch(storySource, /PhotoPlaceholder|Real photo needed/)
  for (const asset of ['beginning-apartment.jpg', 'growth-balcony.jpg', 'care-preparation.jpg', 'attention-to-detail.jpg']) assert.match(storySource, new RegExp(asset.replace('.', '\\.')))
})

test('Contact is a real shared-navigation route using the durable enquiry boundary', () => {
  const headerSource = fs.readFileSync(path.resolve(__dirname, '../src/app/home/HomeHeader.tsx'), 'utf8')
  const navigationSource = fs.readFileSync(path.resolve(__dirname, '../src/app/home/siteNavigation.ts'), 'utf8')
  const footerSource = fs.readFileSync(path.resolve(__dirname, '../src/app/home/SiteFooter.tsx'), 'utf8')
  const propertySource = fs.readFileSync(path.resolve(__dirname, '../src/app/properties/[id]/PropertyDetailClient.tsx'), 'utf8')
  const homepageSource = fs.readFileSync(path.resolve(__dirname, '../src/lib/homepage.ts'), 'utf8')
  const routeSource = fs.readFileSync(path.resolve(__dirname, '../src/app/contact/page.tsx'), 'utf8')
  const pageSource = fs.readFileSync(path.resolve(__dirname, '../src/app/contact/ContactPage.tsx'), 'utf8')

  for (const source of [navigationSource, footerSource]) assert.match(source, /['"]\/contact['"]/)
  assert.match(headerSource, /SITE_NAV_ITEMS/)
  assert.match(propertySource, /SITE_NAV_ITEMS/)
  assert.match(routeSource, /Contact Us \| MZ Property/)
  assert.match(pageSource, /Let’s talk about your property\./)
  assert.match(pageSource, /For property owners/)
  assert.match(pageSource, /Property area \/ suburb/)
  assert.match(pageSource, /Property type/)
  assert.match(pageSource, /Current use/)
  assert.match(pageSource, /What would you like to explore together\?/)
  assert.match(pageSource, /href="\/#properties"/)
  assert.match(pageSource, /Existing bookings/)
  assert.match(pageSource, /Let’s talk/)
  assert.match(pageSource, /Opening the conversation…/)
  assert.match(pageSource, /type="submit"/)
  assert.match(pageSource, /role="combobox"/)
  assert.match(pageSource, /role="listbox"/)
  assert.match(pageSource, /aria-selected=/)
  assert.doesNotMatch(pageSource, /Submit the form below|Send property enquiry|Saving…|<select/)
  assert.match(pageSource, /postJSON<[^>]+>\('\/public\/guest-site\/contact-messages'/)
  assert.match(pageSource, /inquiry_type:\s*'property_management'/)
  assert.match(pageSource, /submissionIdRef\.current \|\| window\.crypto\.randomUUID\(\)/)
  assert.match(pageSource, /if \(inFlightRef\.current\) return/)
  assert.match(pageSource, /Your details are still here, so you can try again/)
  assert.ok(pageSource.indexOf('setValues(EMPTY_VALUES)') > pageSource.indexOf("if (!response?.ok || !response.id) throw"))
  assert.match(pageSource, /DEFAULT_HOMEPAGE_CONTENT/)
  assert.doesNotMatch(pageSource, /EnglishDatePicker|checkIn|checkOut|guests|enquiry-intent/)
  assert.match(homepageSource, /130 Gladstone St, South Melbourne, VIC 3205/)
  assert.doesNotMatch(pageSource, /fetch\s*\(/)
})

test('public routes use one shared responsive site header', () => {
  const headerSource = fs.readFileSync(path.resolve(__dirname, '../src/app/home/HomeHeader.tsx'), 'utf8')
  const headerStyles = fs.readFileSync(path.resolve(__dirname, '../src/app/home/HomeHeader.module.css'), 'utf8')
  const navigationSource = fs.readFileSync(path.resolve(__dirname, '../src/app/home/siteNavigation.ts'), 'utf8')
  const bookingLayoutSource = fs.readFileSync(path.resolve(__dirname, '../src/app/BookingLayout.tsx'), 'utf8')
  const propertySource = fs.readFileSync(path.resolve(__dirname, '../src/app/properties/[id]/PropertyDetailClient.tsx'), 'utf8')
  const placeholderSource = fs.readFileSync(path.resolve(__dirname, '../src/app/property-details/page.tsx'), 'utf8')

  for (const source of [bookingLayoutSource, propertySource, placeholderSource]) assert.match(source, /HomeHeader/)
  assert.match(headerSource, /isCurrentSiteNavigationItem/)
  assert.match(headerSource, /data-site-header/)
  assert.match(headerSource, /aria-controls="mz-primary-nav"/)
  assert.match(navigationSource, /pathname\.startsWith\('\/properties\/'\)/)
  assert.match(headerStyles, /--navHeaderHeight:\s*80px/)
  assert.match(headerStyles, /@media \(max-width:\s*820px\)/)
  assert.match(headerStyles, /\.siteHeader\.compact/)
  assert.doesNotMatch(bookingLayoutSource, /navIconGlyph|menuPanel|menuItems/)
  assert.doesNotMatch(propertySource, /function PropertyHeader|property-primary-nav|const NAV_ITEMS/)
  assert.doesNotMatch(placeholderSource, /<header|className=\{s\.brand\}/)
})

test('homepage stay search opens the real property collection without claiming live availability', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/app/home/AvailabilitySearch.tsx'), 'utf8')
  assert.match(source, /const query = homepageSearchQuery\(values\)/)
  assert.match(source, /window\.history\.replaceState\(window\.history\.state, '', `\/\?\$\{query\}`\)/)
  assert.match(source, /router\.push\(`\/properties\?\$\{query\}`\)/)
  assert.match(source, /View matching properties/)
  assert.match(source, /Live availability is not connected yet/)
  assert.doesNotMatch(source, /router\.push\(`\/property-details/)
})
