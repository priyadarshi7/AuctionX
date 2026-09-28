import { randomUUID } from 'node:crypto';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { env } from '../../config/env';
import { s3Client } from './s3Client';

// A small, fixed allow-list rather than accepting any client-declared
// content type — Section 28: never trust client input, and an object
// store will happily accept and serve back whatever bytes/type it's given.
// Video is Section 1's stated goal too, but deliberately out of scope for
// this first cut (YAGNI) — images alone already exercise the full
// presigned-upload mechanism this task exists to build.
const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type UploadContentType = (typeof ALLOWED_CONTENT_TYPES)[number];
export const ALLOWED_UPLOAD_CONTENT_TYPES: readonly string[] = ALLOWED_CONTENT_TYPES;

const EXTENSION_BY_CONTENT_TYPE: Record<UploadContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// 5MB: generous for a compressed photo, small enough that a client abusing
// this endpoint can't use us as free large-file hosting. Enforced as an S3
// POST POLICY CONDITION below, not just a client-side check — a client that
// skips our frontend entirely and calls the presign endpoint directly still
// can't get a policy that accepts a bigger file, because the constraint is
// baked into the signature itself, not re-validated by us after the fact
// (we never see the upload; it goes straight to the bucket).
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// Seconds the presigned policy remains valid for — short, since a client is
// expected to upload immediately after requesting this, not stockpile
// unused upload slots.
const PRESIGN_EXPIRY_SECONDS = 60;

export type PresignedUpload = {
  uploadUrl: string;
  fields: Record<string, string>;
  publicUrl: string;
};

// Presigned POST (with policy Conditions), not presigned PUT: PUT would
// only let us sign "this exact key may be written," with no way to also
// constrain the file's size or content-type as part of the signature
// itself — those would become unenforceable, client-side-only checks. POST
// policies let the size/type constraints travel WITH the signed permission,
// so they can't be bypassed by a client that ignores our frontend and talks
// to the presign endpoint directly.
//
// The object key is scoped under the seller's own id
// (`auctions/{sellerId}/...`) — this is what makes "any authenticated user
// may call this endpoint" a safe authorization policy: nobody can be handed
// a signature for a key outside their own prefix, so nobody can overwrite
// another seller's upload.
export async function createPresignedUpload(
  sellerId: string,
  contentType: UploadContentType,
): Promise<PresignedUpload> {
  const extension = EXTENSION_BY_CONTENT_TYPE[contentType];
  const objectKey = `auctions/${sellerId}/${randomUUID()}.${extension}`;

  const { url, fields } = await createPresignedPost(s3Client, {
    Bucket: env.S3_BUCKET,
    Key: objectKey,
    Conditions: [['content-length-range', 0, MAX_UPLOAD_BYTES], { 'Content-Type': contentType }],
    Fields: {
      'Content-Type': contentType,
    },
    Expires: PRESIGN_EXPIRY_SECONDS,
  });

  return {
    uploadUrl: url,
    fields,
    publicUrl: `${env.S3_PUBLIC_URL_BASE}/${objectKey}`,
  };
}
