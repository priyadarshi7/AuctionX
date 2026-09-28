import { z } from 'zod';
import { ALLOWED_UPLOAD_CONTENT_TYPES, type UploadContentType } from '../../infrastructure/storage/presign';

// z.enum needs a non-empty tuple literal, not a generic string[] — this
// asserts the shared allow-list (infrastructure/storage/presign.ts) has the
// shape Zod requires, rather than duplicating the list of types here too.
const [firstType, ...restTypes] = ALLOWED_UPLOAD_CONTENT_TYPES as [UploadContentType, ...UploadContentType[]];

export const presignUploadSchema = z.object({
  contentType: z.enum([firstType, ...restTypes]),
});

export type PresignUploadInput = z.infer<typeof presignUploadSchema>;
