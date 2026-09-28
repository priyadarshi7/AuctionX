import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { validateBody } from '../../middleware/validate';
import { presignUploadHandler } from './controller';
import { presignUploadSchema } from './schema';

export const uploadRoutes = Router();

// No dedicated rate limiter — the already-global apiRateLimit (300/min
// authenticated) covers this. Unlike bid placement (ADR-0018), a presign
// call costs us nothing but a local signature computation; the real
// resource it gates (bucket storage/bandwidth) is bounded per-object by the
// signed policy itself (presign.ts's MAX_UPLOAD_BYTES), not by call
// frequency.
uploadRoutes.post('/presign', authenticate, validateBody(presignUploadSchema), presignUploadHandler);
