import { z } from 'zod';
import {
  ALLOWED_DOCUMENT_CONTENT_TYPES,
  type DocumentContentType,
} from '../../infrastructure/storage/documents';

// Same non-empty-tuple trick as uploads/schema.ts: one shared allow-list.
const [firstType, ...restTypes] = ALLOWED_DOCUMENT_CONTENT_TYPES as [DocumentContentType, ...DocumentContentType[]];
const contentTypeSchema = z.enum([firstType, ...restTypes]);

export const presignDocumentSchema = z.object({ contentType: contentTypeSchema });
export type PresignDocumentInput = z.infer<typeof presignDocumentSchema>;

// What the client reports AFTER uploading. fileName is display-only; the
// size and type are re-read from the bucket by the service, so the values
// here are never trusted.
export const registerDocumentSchema = z.object({
  objectKey: z.string().trim().min(1).max(300),
  fileName: z.string().trim().min(1).max(200),
  contentType: contentTypeSchema,
});
export type RegisterDocumentInput = z.infer<typeof registerDocumentSchema>;
