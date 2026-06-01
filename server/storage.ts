import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { ServerConfig } from './config'

export interface StoredObject {
  key: string
  mimeType: string
  buffer: Buffer
}

export function createS3Client(config: ServerConfig) {
  return new S3Client({
    endpoint: config.s3.endpoint,
    region: config.s3.region,
    forcePathStyle: config.s3.forcePathStyle,
    credentials: {
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
    },
  })
}

export async function assertBucketReachable(client: S3Client, config: ServerConfig) {
  await client.send(new HeadBucketCommand({ Bucket: config.s3.bucket }))
}

export async function putObject(
  client: S3Client,
  config: ServerConfig,
  object: StoredObject,
) {
  await client.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: object.key,
    Body: object.buffer,
    ContentType: object.mimeType,
  }))
}

export async function deleteObjects(
  client: S3Client,
  config: ServerConfig,
  keys: string[],
) {
  const uniqueKeys = [...new Set(keys.filter(Boolean))]
  await Promise.all(uniqueKeys.map((key) =>
    client.send(new DeleteObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
    })),
  ))
}

export async function getObjectBuffer(
  client: S3Client,
  config: ServerConfig,
  key: string,
): Promise<Buffer> {
  const response = await client.send(new GetObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
  }))
  const bytes = await response.Body?.transformToByteArray()
  if (!bytes) throw new Error('图片对象不存在')
  return Buffer.from(bytes)
}

export async function createSignedImageUrl(
  client: S3Client,
  config: ServerConfig,
  key: string,
) {
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }),
    { expiresIn: 60 * 10 },
  )
}

export async function listObjectKeys(
  client: S3Client,
  config: ServerConfig,
  prefix = '',
) {
  const keys: string[] = []
  let continuationToken: string | undefined
  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: config.s3.bucket,
      Prefix: prefix || undefined,
      ContinuationToken: continuationToken,
    }))
    for (const object of response.Contents ?? []) {
      if (object.Key) keys.push(object.Key)
    }
    continuationToken = response.NextContinuationToken
  } while (continuationToken)
  return keys
}
