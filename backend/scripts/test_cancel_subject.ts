const subj = 'cancel reservation HMC5QACQYP for 22 Feb-1 Mar Your calendar has been updated to show that these dates are now available.'
const code = subj.match(/\b[A-Z0-9]{8,10}\b/)?.[0] || ''
const isCancel = /\bcancel\s+reservation\b/i.test(subj)
console.log(JSON.stringify({ isCancel, code }))
