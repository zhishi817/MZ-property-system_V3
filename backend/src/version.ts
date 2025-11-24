export const appVersion: string = require('../package.json').version || '0.0.0'
export const buildTimestamp: string = process.env.BUILD_TIMESTAMP || new Date().toISOString()
export const commitRef: string = process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT_REF || process.env.RENDER_GIT_COMMIT || ''

