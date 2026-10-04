import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env';
import { logger } from '../observability/logger';
import { s3Client } from './s3Client';

// Seller documents (ADR-0041) live in their OWN, PRIVATE bucket
// (S3_DOCS_BUCKET) and are never given a public URL: certificates and
// receipts routinely carry names, addresses and serial numbers. The only way
// to read one is a short-lived signed URL, handed to the seller or an admin
// after the API has checked who is asking.

const ALLOWED_DOCUMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;
export type DocumentContentType = (typeof ALLOWED_DOCUMENT_TYPES)[number];
export const ALLOWED_DOCUMENT_CONTENT_TYPES: readonly string[] = ALLOWED_DOCUMENT_TYPES;

const EXTENSION_BY_TYPE: Record<DocumentContentType, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// Bigger than the 5MB image limit: a scanned certificate or multi-page PDF
// is legitimately larger than a compressed photo. Enforced as an S3 POST
// policy condition (so it can't be skipped by a client that bypasses our
// UI) AND re-checked against the real object size at registration.
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const PRESIGN_UPLOAD_EXPIRY_SECONDS = 60;
// Long enough to open the document, short enough that a leaked link is
// nearly useless. A fresh one is minted on every list call.
const SIGNED_DOWNLOAD_EXPIRY_SECONDS = 300;

export function documentKeyPrefix(auctionId: string): string {
  return `documents/${auctionId}/`;
}

export async function createPresignedDocumentUpload(
  auctionId: string,
  contentType: DocumentContentType,
): Promise<{ uploadUrl: string; fields: Record<string, string>; objectKey: string }> {
  const objectKey = `${documentKeyPrefix(auctionId)}${randomUUID()}.${EXTENSION_BY_TYPE[contentType]}`;
  const { url, fields } = await createPresignedPost(s3Client, {
    Bucket: env.S3_DOCS_BUCKET,
    Key: objectKey,
    Conditions: [['content-length-range', 0, MAX_DOCUMENT_BYTES], { 'Content-Type': contentType }],
    Fields: { 'Content-Type': contentType },
    Expires: PRESIGN_UPLOAD_EXPIRY_SECONDS,
  });
  return { uploadUrl: url, fields, objectKey };
}

// What actually landed in the bucket, or null if nothing did. Registration
// trusts this, not whatever size/type the client claims.
export async function headDocumentObject(
  objectKey: string,
): Promise<{ sizeBytes: number; contentType: string | undefined } | null> {
  try {
    const head = await s3Client.send(new HeadObjectCommand({ Bucket: env.S3_DOCS_BUCKET, Key: objectKey }));
    return { sizeBytes: head.ContentLength ?? 0, contentType: head.ContentType };
  } catch (err) {
    const name = (err as { name?: string }).name;
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (name === 'NotFound' || name === 'NoSuchKey' || status === 404) return null;
    throw err;
  }
}

// Quotes and control characters stripped so a hostile file name can't break
// out of the Content-Disposition header.
function safeFileName(fileName: string): string {
  return fileName.replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'document';
}

export function createSignedDocumentUrl(objectKey: string, fileName: string): Promise<string> {
  return getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: env.S3_DOCS_BUCKET,
      Key: objectKey,
      ResponseContentDisposition: `inline; filename="${safeFileName(fileName)}"`,
    }),
    { expiresIn: SIGNED_DOWNLOAD_EXPIRY_SECONDS },
  );
}

// The object's bytes, for scanning. Bounded by MAX_DOCUMENT_BYTES, which
// registration has already verified against the real size.
export async function readDocumentObject(objectKey: string): Promise<Buffer> {
  const res = await s3Client.send(new GetObjectCommand({ Bucket: env.S3_DOCS_BUCKET, Key: objectKey }));
  return Buffer.from(await res.Body!.transformToByteArray());
}

export async function listDocumentObjects(
  continuationToken?: string,
): Promise<{ objects: { key: string; lastModified: Date | undefined }[]; nextToken: string | undefined }> {
  const res = await s3Client.send(
    new ListObjectsV2Command({
      Bucket: env.S3_DOCS_BUCKET,
      Prefix: 'documents/',
      ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
    }),
  );
  return {
    objects: (res.Contents ?? []).flatMap((o) => (o.Key ? [{ key: o.Key, lastModified: o.LastModified }] : [])),
    nextToken: res.IsTruncated ? res.NextContinuationToken : undefined,
  };
}

// Best effort, batched (S3 allows 1000 keys per request). Returns how many
// were deleted; a failed batch is logged and left for the orphan sweeper.
export async function deleteDocumentObjects(objectKeys: string[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < objectKeys.length; i += 1000) {
    const batch = objectKeys.slice(i, i + 1000);
    try {
      const res = await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: env.S3_DOCS_BUCKET,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      deleted += batch.length - (res.Errors?.length ?? 0);
    } catch (err) {
      logger.warn({ err, count: batch.length }, 'storage.document_batch_delete_failed');
    }
  }
  return deleted;
}

// Best effort: a failed object delete leaves an orphan file in a private
// bucket, which is harmless and cheaper than failing the user's request.
export async function deleteDocumentObject(objectKey: string): Promise<void> {
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: env.S3_DOCS_BUCKET, Key: objectKey }));
  } catch (err) {
    logger.warn({ err, objectKey }, 'storage.document_delete_failed');
  }
}
