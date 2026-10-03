import { apiFetch } from './apiClient';

// Client-side mirror of services/api/src/infrastructure/storage/documents.ts.
// Only a UX convenience (skip an obviously wrong file before spending a
// round trip); the server re-validates type and measures the real size.
const ALLOWED_DOCUMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENTS = 5;
export const DOCUMENT_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp';

// Categories the server requires paperwork for (reviewPolicy.ts). Mirrored
// only to explain the requirement before the seller hits submit; the server
// enforces it regardless.
export const DOCUMENT_REQUIRED_CATEGORIES = ['WATCHES', 'JEWELRY', 'ART', 'COINS_AND_CURRENCY'];

export type AuctionDocument = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  // Short-lived signed link, only on list responses.
  url?: string;
};

export function checkDocumentFile(file: File): string | null {
  if (!ALLOWED_DOCUMENT_TYPES.includes(file.type)) return 'Use a PDF, JPG, PNG or WebP file.';
  if (file.size > MAX_DOCUMENT_BYTES) return 'That file is over 10 MB.';
  return null;
}

export function listDocumentsRequest(accessToken: string, auctionId: string): Promise<{ documents: AuctionDocument[] }> {
  return apiFetch(`/auctions/${auctionId}/documents`, { accessToken });
}

export function removeDocumentRequest(accessToken: string, auctionId: string, documentId: string): Promise<void> {
  return apiFetch(`/auctions/${auctionId}/documents/${documentId}`, { method: 'DELETE', accessToken });
}

// Three steps, the same shape as image upload (lib/uploads.ts): ask the API
// for a presigned POST, upload straight to the (private) bucket, then tell
// the API the upload happened so it can verify and record it. The bytes
// never pass through our server.
export async function uploadDocument(accessToken: string, auctionId: string, file: File): Promise<void> {
  const presign = await apiFetch<{ uploadUrl: string; fields: Record<string, string>; objectKey: string }>(
    `/auctions/${auctionId}/documents/presign`,
    { method: 'POST', body: { contentType: file.type }, accessToken },
  );

  const form = new FormData();
  for (const [key, value] of Object.entries(presign.fields)) form.append(key, value);
  form.append('file', file);
  const res = await fetch(presign.uploadUrl, { method: 'POST', body: form });
  if (!res.ok) {
    throw new Error('The upload failed. Please try again.');
  }

  await apiFetch(`/auctions/${auctionId}/documents`, {
    method: 'POST',
    body: { objectKey: presign.objectKey, fileName: file.name, contentType: file.type },
    accessToken,
  });
}
