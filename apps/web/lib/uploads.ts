import { apiFetch } from './apiClient';

// Mirrors services/api's infrastructure/storage/presign.ts allow-list —
// duplicated, not shared, matching this codebase's existing pattern for
// validation schemas (lib/validation/auth.ts's own comment on why). This
// copy is purely a client-side UX convenience (skip an obviously-wrong file
// before spending a round trip); the server re-validates independently and
// is the actual authority.
const ALLOWED_UPLOAD_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export function isAllowedImageFile(file: File): boolean {
  return ALLOWED_UPLOAD_CONTENT_TYPES.includes(file.type);
}

export type PresignedUpload = {
  uploadUrl: string;
  fields: Record<string, string>;
  publicUrl: string;
};

export function requestPresignedUpload(accessToken: string, contentType: string): Promise<PresignedUpload> {
  return apiFetch<PresignedUpload>('/uploads/presign', {
    method: 'POST',
    body: { contentType },
    accessToken,
  });
}

// Uploads DIRECTLY to object storage using the presigned POST fields the
// backend returned — never routed through our own server (Section 27: a
// media upload's bytes are exactly the kind of thing that shouldn't spend
// our application server's bandwidth). `apiFetch` isn't used here on
// purpose: this request goes to a completely different origin (the storage
// bucket, not our API), needs multipart form data instead of JSON, and
// must NOT send our app's Authorization header or cookies — the presigned
// fields ARE the credential for this one request.
export async function uploadToPresignedUrl(presigned: PresignedUpload, file: File): Promise<string> {
  const form = new FormData();
  for (const [key, value] of Object.entries(presigned.fields)) {
    form.append(key, value);
  }
  form.append('file', file);

  const res = await fetch(presigned.uploadUrl, { method: 'POST', body: form });
  if (!res.ok) {
    throw new Error('Image upload failed. Please try again.');
  }
  return presigned.publicUrl;
}
