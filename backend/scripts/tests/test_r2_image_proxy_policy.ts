import { isAllowedR2ImageKey, R2_IMAGE_ALLOWED_PREFIXES } from '../../src/lib/r2ImageProxyPolicy'

function assertOk(name: string, cond: any, extra?: any) {
  if (!cond) throw new Error(`${name} failed${extra !== undefined ? ` extra=${JSON.stringify(extra)}` : ''}`)
}

assertOk('prefix list includes deep-cleaning-upload', R2_IMAGE_ALLOWED_PREFIXES.includes('deep-cleaning-upload/'), R2_IMAGE_ALLOWED_PREFIXES)
assertOk('deep-cleaning-upload allowed', isAllowedR2ImageKey('deep-cleaning-upload/a.jpg') === true)
assertOk('deep-cleaning allowed', isAllowedR2ImageKey('deep-cleaning/a.jpg') === true)
assertOk('maintenance allowed', isAllowedR2ImageKey('maintenance/a.jpg') === true)
assertOk('random denied', isAllowedR2ImageKey('random/a.jpg') === false)

process.stdout.write('ok\n')

