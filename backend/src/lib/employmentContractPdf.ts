import { getChromiumBrowser, resetChromiumBrowser } from './playwright'

export type EmploymentContractPdfInput = {
  contractNo: string
  fields: Record<string, any>
  generatedAt?: Date
}

export type EmploymentContractPdfResult = {
  pdf: Buffer
  filename: string
}

function escapeHtml(value: any) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function text(fields: Record<string, any>, key: string, fallback = '') {
  const value = String(fields?.[key] ?? '').trim()
  return value || fallback
}

function formatDate(value: any) {
  const raw = String(value || '').trim()
  if (!raw) return '________年____月____日'
  const matched = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!matched) return raw
  return `${matched[1]}年${Number(matched[2])}月${Number(matched[3])}日`
}

function formatEnglishDate(value: any) {
  const raw = String(value || '').trim()
  if (!raw) return '________'
  const date = new Date(`${raw.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return raw
  return new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

function formatMoney(value: any) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return String(value || '')
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(amount)
}

function lines(value: any) {
  return String(value || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function bilingualList(cn: any, en: any) {
  const cnLines = lines(cn)
  const enLines = lines(en)
  const count = Math.max(cnLines.length, enLines.length)
  if (!count) return ''
  return `<ol class="duties">${Array.from({ length: count }, (_, index) => `
    <li>
      <div>${escapeHtml(cnLines[index] || '')}</div>
      <div class="en">${escapeHtml(enLines[index] || '')}</div>
    </li>
  `).join('')}</ol>`
}

function contractTerm(fields: Record<string, any>) {
  const effectiveDate = text(fields, 'effective_date')
  if (text(fields, 'contract_term_type', 'open_ended') === 'fixed_term') {
    const endDate = text(fields, 'end_date')
    return {
      cn: `本合同为固定期限劳动合同，自 ${formatDate(effectiveDate)} 起至 ${formatDate(endDate)} 止。`,
      en: `This is a fixed-term labor contract, effective from ${formatEnglishDate(effectiveDate)} to ${formatEnglishDate(endDate)}.`,
    }
  }
  return {
    cn: `本合同为无固定期限劳动合同，自 ${formatDate(effectiveDate)} 起生效。`,
    en: `This is an open-ended labor contract, effective from ${formatEnglishDate(effectiveDate)}.`,
  }
}

function socialInsuranceClause(fields: Record<string, any>) {
  const city = text(fields, 'social_insurance_city', '南京市')
  const baseNote = text(fields, 'contribution_base_note')
  if (text(fields, 'social_insurance_mode', 'standard') === 'pending') {
    return {
      cn: `双方确认，劳动关系存续期间社会保险及住房公积金应依法办理。当前暂未由甲方为乙方办理缴纳手续，具体原因、期限及后续安排由双方另行书面确认。本条不构成对任何法定义务的免除，后续应按照适用法律法规及主管部门要求处理。${baseNote ? ` 补充说明：${baseNote}` : ''}`,
      en: `Both parties acknowledge that social insurance and the housing provident fund shall be handled in accordance with applicable law. Party A is not currently processing contributions for Party B; the reason, period and follow-up arrangements shall be separately confirmed in writing. This clause does not waive any statutory obligation, and the matter shall be handled according to applicable laws and authority requirements.${baseNote ? ` Additional note: ${baseNote}` : ''}`,
    }
  }
  return {
    cn: `双方经协商一致，甲方按照${city}社会保险及住房公积金相关规定及双方商定的缴纳基数为乙方正常缴纳五险一金。具体缴纳标准以当地政策及双方书面确认为准。${baseNote ? ` 补充说明：${baseNote}` : ''}`,
    en: `After mutual negotiation, Party A shall pay social insurance and the housing provident fund for Party B in accordance with the relevant regulations of ${city} and the contribution base agreed by both parties. Specific standards shall be confirmed in writing based on local policies.${baseNote ? ` Additional note: ${baseNote}` : ''}`,
  }
}

function article(number: number, titleCn: string, titleEn: string, body: string) {
  return `
    <section class="article">
      <h3>第${number === 1 ? '一' : number === 2 ? '二' : number === 3 ? '三' : number === 4 ? '四' : number === 5 ? '五' : number === 6 ? '六' : number === 7 ? '七' : number === 8 ? '八' : number === 9 ? '九' : '十'}条 ${escapeHtml(titleCn)} <span>Article ${number} ${escapeHtml(titleEn)}</span></h3>
      ${body}
    </section>
  `
}

export function renderEmploymentContractHtml(input: EmploymentContractPdfInput) {
  const fields = input.fields || {}
  const term = contractTerm(fields)
  const social = socialInsuranceClause(fields)
  const probationMonths = Number(fields.probation_months || 0)
  const noticeDays = Number(fields.termination_notice_days || 60)
  const generatedAt = input.generatedAt || new Date()
  const generatedDate = generatedAt.toISOString().slice(0, 10)
  const salary = formatMoney(fields.monthly_salary)
  const payday = Number(fields.payday || 7)
  const employer = text(fields, 'employer_name', '南京知日科技有限公司')
  const jobTitleCn = text(fields, 'job_title_cn', '客服')
  const jobTitleEn = text(fields, 'job_title_en', 'Customer Service')
  const workLocationCn = text(fields, 'work_location_cn', '远程办公（居家办公）')
  const workLocationEn = text(fields, 'work_location_en', 'Remote work (work from home)')
  const timeZone = text(fields, 'work_timezone', '墨尔本时间')
  const coreStart = text(fields, 'core_hours_start', '09:00')
  const coreEnd = text(fields, 'core_hours_end', '16:00')
  const flexibleStart = text(fields, 'flexible_hours_start', '16:00')
  const flexibleEnd = text(fields, 'flexible_hours_end', '21:00')
  const restDaysCn = text(fields, 'rest_days_cn', '周日、周一')
  const restDaysEn = text(fields, 'rest_days_en', 'Sunday and Monday')
  const paymentMethodCn = text(fields, 'payment_method_cn', '银行卡转账')
  const paymentMethodEn = text(fields, 'payment_method_en', 'Bank transfer')

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <style>
        @page { size: A4; margin: 12mm 14mm; }
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; color: #151515; background: #fff; font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif; font-size: 10.5px; line-height: 1.5; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .page { position: relative; break-after: page; page-break-after: always; }
        .page:last-child { break-after: auto; page-break-after: auto; }
        h1 { margin: 0; text-align: center; font-size: 21px; letter-spacing: 1px; }
        .subtitle { margin: 1mm 0 5mm; text-align: center; color: #555; font-size: 10px; }
        .page-meta { display: flex; justify-content: space-between; margin: 0 0 3mm; color: #666; font-size: 8.5px; }
        h2 { margin: 4mm 0 2mm; padding-bottom: 1mm; border-bottom: 1.5px solid #222; font-size: 14px; }
        h2 span, h3 span { margin-left: 2mm; font-weight: 500; color: #444; }
        h3 { margin: 3mm 0 1mm; font-size: 11.2px; }
        p { margin: 0 0 1.5mm; text-align: justify; }
        .en { color: #3f3f3f; font-family: Arial, sans-serif; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 3mm; }
        th, td { border: 1px solid #bdbdbd; padding: 1.7mm 2mm; text-align: left; vertical-align: top; }
        th { width: 22%; background: #f3f4f6; font-weight: 700; }
        .article { break-inside: avoid; page-break-inside: avoid; }
        .duties { margin: 1mm 0 2mm 5mm; padding-left: 4mm; }
        .duties li { margin-bottom: 1.4mm; }
        .numbered { margin: 1mm 0 2mm 5mm; padding-left: 4mm; }
        .numbered li { margin-bottom: 1.4mm; }
        .notice { padding: 2mm 2.5mm; border-left: 3px solid #555; background: #f7f7f7; }
        .signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 12mm; margin-top: 13mm; }
        .signature-box { min-height: 42mm; border-top: 1px solid #222; padding-top: 2mm; }
        .signature-box p { margin-bottom: 3mm; }
      </style>
    </head>
    <body>
      <section class="page">
        <h1>劳动合同 · 保密协议 · 培训协议</h1>
        <div class="subtitle">Labor Contract · Confidentiality Agreement · Training Agreement (Bilingual Version)</div>
        <div class="page-meta"><span>合同编号 Contract No.: ${escapeHtml(input.contractNo)}</span><span>1 / 4</span></div>

        <h2>甲方（用人单位 / 公司）<span>Party A (Employer)</span></h2>
        <table>
          <tr><th>名称 Name</th><td>${escapeHtml(employer)}</td><th>统一社会信用代码</th><td>${escapeHtml(text(fields, 'employer_credit_code'))}</td></tr>
          <tr><th>法定代表人</th><td>${escapeHtml(text(fields, 'legal_representative'))}</td><th>地址 Address</th><td>${escapeHtml(text(fields, 'employer_address'))}</td></tr>
        </table>

        <h2>乙方（劳动者 / 员工）<span>Party B (Employee)</span></h2>
        <table>
          <tr><th>姓名 Name</th><td>${escapeHtml(text(fields, 'employee_name'))}</td><th>身份证号 ID No.</th><td>${escapeHtml(text(fields, 'employee_id_no'))}</td></tr>
          <tr><th>联系电话 Phone</th><td>${escapeHtml(text(fields, 'employee_phone'))}</td><th>地址 Address</th><td>${escapeHtml(text(fields, 'employee_address'))}</td></tr>
        </table>

        <h2>第一部分：劳动合同 <span>Part 1: Labor Contract</span></h2>
        ${article(1, '合同期限', 'Contract Term', `
          <p>${escapeHtml(term.cn)}</p>
          <p class="en">${escapeHtml(term.en)}</p>
          <p>试用期：${probationMonths > 0 ? `${probationMonths}个月，自合同生效之日起计算。` : '不设置试用期。'}</p>
          <p class="en">Probation period: ${probationMonths > 0 ? `${probationMonths} month(s) from the effective date.` : 'No probation period.'}</p>
        `)}
        ${article(2, '工作内容', 'Job Duties', `
          <p>乙方担任${escapeHtml(jobTitleCn)}岗位，工作内容包括但不限于：</p>
          <p class="en">Party B serves as ${escapeHtml(jobTitleEn)}, with job duties including but not limited to:</p>
          ${bilingualList(fields.job_duties_cn, fields.job_duties_en)}
          <p>乙方同意甲方根据经营需要合理调整工作内容。</p>
          <p class="en">Party B agrees that Party A may reasonably adjust job duties based on operational needs.</p>
        `)}
        ${article(3, '工作地点', 'Work Location', `
          <p>${escapeHtml(workLocationCn)}</p>
          <p class="en">${escapeHtml(workLocationEn)}</p>
        `)}
      </section>

      <section class="page">
        <h2>第一部分：劳动合同（续） <span>Part 1: Labor Contract (Continued)</span></h2>
        <div class="page-meta"><span>合同编号 Contract No.: ${escapeHtml(input.contractNo)}</span><span>2 / 4</span></div>
        ${article(4, '工作时间', 'Working Hours', `
          <p>弹性工作制。每日核心工作时间：${escapeHtml(timeZone)} ${escapeHtml(coreStart)} - ${escapeHtml(coreEnd)}；弹性工作时间：${escapeHtml(timeZone)} ${escapeHtml(flexibleStart)} - ${escapeHtml(flexibleEnd)}。在核心时段内，乙方应保持在线并可响应工作；弹性时段内，乙方可根据工作安排和自身情况灵活处理工作，但需保证完成当日岗位职责。每周${escapeHtml(restDaysCn)}休息。本合同不另计算加班，双方确认上述安排已综合考虑工作内容与报酬。</p>
          <p class="en">Flexible working arrangement. Core working hours: ${escapeHtml(timeZone)} ${escapeHtml(coreStart)} - ${escapeHtml(coreEnd)}; flexible working hours: ${escapeHtml(timeZone)} ${escapeHtml(flexibleStart)} - ${escapeHtml(flexibleEnd)}. During core hours, Party B shall remain online and responsive. During flexible hours, Party B may arrange work according to operational needs and personal circumstances, provided that all daily job duties are completed. Weekly rest days are ${escapeHtml(restDaysEn)}. No separate overtime pay. Both parties confirm this arrangement.</p>
        `)}
        ${article(5, '劳动报酬', 'Remuneration', `
          <p>税前月薪：人民币 ${escapeHtml(salary)} 元 | 发放日期：每月${payday}号 | 支付方式：${escapeHtml(paymentMethodCn)}</p>
          <p class="en">Monthly salary before tax: RMB ${escapeHtml(salary)}. Payment date: the ${payday}${payday === 1 ? 'st' : payday === 2 ? 'nd' : payday === 3 ? 'rd' : 'th'} day of each month. Payment method: ${escapeHtml(paymentMethodEn)}.</p>
        `)}
        ${article(6, '社会保险和住房公积金', 'Social Insurance & Housing Fund', `
          <div class="notice">
            <p>${escapeHtml(social.cn)}</p>
            <p class="en">${escapeHtml(social.en)}</p>
          </div>
        `)}
        ${article(7, '保密与培训协议', 'Confidentiality & Training Agreement', `
          <p>乙方需另行签署《保密协议》及《培训协议》，为本合同不可分割的一部分。</p>
          <p class="en">Party B shall separately sign the Confidentiality Agreement and Training Agreement, which form integral parts of this contract.</p>
        `)}
        ${article(8, '合同解除通知期', 'Termination Notice Period', `
          <p>任何一方拟解除本合同，需提前${noticeDays}天向对方发出书面通知，但法律法规另有规定的除外。</p>
          <p class="en">Either party intending to terminate this contract shall provide ${noticeDays} days' prior written notice, unless otherwise provided by applicable law.</p>
        `)}
        ${article(9, '即时终止条件（重大错误）', 'Immediate Termination (Material Error)', `
          <p>若乙方出现以下任一情形，构成重大错误，甲方有权依法立即终止本合同：</p>
          <p class="en">If Party B commits any of the following acts, it constitutes a material error and Party A may terminate this contract immediately in accordance with law:</p>
          <ol class="numbered">
            <li>泄露保密信息（客户数据、房源信息、定价策略等）<div class="en">Disclosure of confidential information.</div></li>
            <li>严重失职，因故意或重大过失导致订单丢失、平台下架、客户重大投诉等<div class="en">Gross negligence causing material operational loss.</div></li>
            <li>虚假索赔或侵占公司资金、财物<div class="en">Fraudulent claims or misappropriation of company funds or property.</div></li>
            <li>无故连续旷工3天或累计旷工5天<div class="en">Unexcused absence for 3 consecutive days or 5 cumulative days.</div></li>
            <li>违反法律法规，严重损害公司声誉或利益<div class="en">Serious violation of law harming the company's reputation or interests.</div></li>
            <li>伪造工作记录、客户沟通记录、房源信息表或维修单据<div class="en">Falsifying work or business records.</div></li>
            <li>未经同意同时为竞争对手服务<div class="en">Providing services to competitors without prior consent.</div></li>
          </ol>
          <p>甲方判定乙方存在上述行为时，应提供合理依据。</p>
          <p class="en">Party A shall provide reasonable basis when determining that Party B committed any of the above acts.</p>
        `)}
        ${article(10, '适用法律与争议解决', 'Governing Law & Dispute Resolution', `
          <p>适用法律：中华人民共和国法律。争议解决：协商不成，依法向有管辖权的人民法院提起诉讼。</p>
          <p class="en">Governing law: Laws of the People's Republic of China. If negotiation fails, either party may file a lawsuit with a competent people's court.</p>
        `)}
      </section>

      <section class="page">
        <h2>第二部分：保密协议 <span>Part 2: Confidentiality Agreement</span></h2>
        <div class="page-meta"><span>合同编号 Contract No.: ${escapeHtml(input.contractNo)}</span><span>3 / 4</span></div>
        ${article(1, '保密内容', 'Confidential Information', `
          <p>乙方在任职期间接触到的以下信息均属保密信息：客户信息（姓名、联系方式、入住记录等）；房源数据（地址、价格、日历、供应商信息）；公司运营流程、定价策略、财务数据；大楼联系方式及物业管理信息；甲方明确标注“保密”的其他文件或信息。</p>
          <p class="en">Confidential information includes but is not limited to customer data, property details, pricing, operational processes, financial data, building contacts and any materials marked "confidential".</p>
        `)}
        ${article(2, '保密义务', 'Confidentiality Obligations', `
          <p>乙方不得向任何第三方披露、泄露保密信息；不得私自复制、保存或带离工作环境；不得为自己或他人利益使用保密信息。合同终止后，保密义务持续有效，直至信息依法进入公共领域。</p>
          <p class="en">Party B shall not disclose confidential information to any third party, copy or remove it without authorization, or use it for personal or third-party benefit. The obligation survives termination until the information lawfully enters the public domain.</p>
        `)}
        ${article(3, '违约责任', 'Breach Liability', `
          <p>若乙方违反本协议，甲方有权依法采取措施，包括解除劳动合同、要求赔偿因此遭受的实际损失并追究相应法律责任。</p>
          <p class="en">If Party B breaches this agreement, Party A may take measures in accordance with law, including terminating the labor contract, claiming actual losses and pursuing applicable legal liability.</p>
        `)}
      </section>

      <section class="page">
        <h2>第三部分：培训协议 <span>Part 3: Training Agreement</span></h2>
        <div class="page-meta"><span>合同编号 Contract No.: ${escapeHtml(input.contractNo)}</span><span>4 / 4</span></div>
        ${article(1, '培训内容', 'Training Content', `
          <p>甲方将为乙方提供岗位相关培训，包括但不限于：房源管理系统操作、客户服务标准流程、索赔及维修流程、Airtasker 等平台使用培训。</p>
          <p class="en">Party A shall provide job-related training including property system operations, customer service procedures, claim and maintenance processes, and platform usage.</p>
        `)}
        ${article(2, '双方义务', 'Mutual Obligations', `
          <p>乙方应积极配合完成甲方组织的必要培训，提升业务能力。甲方提供培训资源，乙方无需向甲方支付任何培训费用。乙方确认，无论因何种原因解除合同，均无需向甲方支付培训费或赔偿培训成本。</p>
          <p class="en">Party B shall actively participate in necessary training. Party A bears all training costs. Under no circumstances shall Party B be required to reimburse or pay any training fees to Party A.</p>
        `)}
        ${article(3, '无服务期及费用', 'No Service Period & No Fee', `
          <p>双方确认：甲方提供的培训均为在岗常规培训，不设置服务期，乙方离职时无需向甲方支付任何培训违约金或补偿。</p>
          <p class="en">Both parties confirm that all training provided is regular on-the-job training. No service period is attached, and Party B is not required to pay any penalty or compensation upon termination.</p>
        `)}

        <div class="signatures">
          <div class="signature-box">
            <p><strong>甲方（盖章） Party A (Seal)</strong></p>
            <p>授权代表：${escapeHtml(text(fields, 'employer_authorized_representative'))}</p>
            <p>签字：____________________________</p>
            <p>日期：${escapeHtml(formatDate(fields.employer_sign_date))}</p>
          </div>
          <div class="signature-box">
            <p><strong>乙方（签字） Party B (Signature)</strong></p>
            <p>姓名：${escapeHtml(text(fields, 'employee_name'))}</p>
            <p>签字：____________________________</p>
            <p>日期：${escapeHtml(formatDate(fields.employee_sign_date))}</p>
          </div>
        </div>

        <p style="margin-top: 12mm;">本合同（含保密协议、培训协议）一式两份，甲乙双方各执一份，具有同等法律效力。</p>
        <p class="en">This contract, including the Confidentiality Agreement and Training Agreement, is made in duplicate and each party holds one copy with equal legal effect.</p>
        <p style="margin-top: 4mm;">合同生成日期：${escapeHtml(formatDate(generatedDate))}。双方签署后生效，电子版与纸质版一致有效。</p>
        <p class="en">Generated on ${escapeHtml(formatEnglishDate(generatedDate))}. Effective after execution by both parties; electronic and paper versions have equal effect.</p>
      </section>
    </body>
  </html>`
}

function isPlaywrightClosedError(error: any) {
  return /(Target page, context or browser has been closed|browser has been closed|browser disconnected|Target closed)/i.test(String(error?.message || ''))
}

export async function generateEmploymentContractPdf(input: EmploymentContractPdfInput): Promise<EmploymentContractPdfResult> {
  const html = renderEmploymentContractHtml(input)
  const runOnce = async () => {
    let browser = await getChromiumBrowser()
    let context: any = null
    try {
      try {
        context = await browser.newContext()
      } catch (error: any) {
        if (!isPlaywrightClosedError(error)) throw error
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
  } catch (error: any) {
    if (!isPlaywrightClosedError(error)) throw error
    await resetChromiumBrowser()
    pdf = await runOnce()
  }
  const safeNo = String(input.contractNo || Date.now()).replace(/[^a-zA-Z0-9._-]+/g, '-')
  return { pdf, filename: `employment-contract-${safeNo}.pdf` }
}
