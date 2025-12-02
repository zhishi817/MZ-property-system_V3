import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const endpoint = process.env.R2_ENDPOINT || ''
const accessKeyId = process.env.R2_ACCESS_KEY_ID || ''
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || ''
const bucket = process.env.R2_BUCKET || ''
const publicBase = process.env.R2_PUBLIC_BASE || ''

export const hasR2 = !!(endpoint && accessKeyId && secretAccessKey && bucket)

export const r2 = hasR2 ? new S3Client({ region: 'auto', endpoint, credentials: { accessKeyId, secretAccessKey } }) : null

export async function r2Upload(key: string, contentType: string, body: Buffer) {
  if (!hasR2 || !r2) throw new Error('R2 not configured')
  await r2.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }))
  const url = publicBase ? `${publicBase}/${key}` : `${endpoint}/${bucket}/${key}`
  return url
}