import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { validateBody } from '../../middleware/validate';
import {
  listDocumentsHandler,
  presignDocumentHandler,
  registerDocumentHandler,
  removeDocumentHandler,
} from './controller';
import { presignDocumentSchema, registerDocumentSchema } from './schema';

// mergeParams: mounted at /auctions/:auctionId/documents, same pattern as
// the bids router, so :auctionId is visible here.
export const documentRoutes = Router({ mergeParams: true });

documentRoutes.use(authenticate);
documentRoutes.get('/', listDocumentsHandler);
documentRoutes.post('/presign', validateBody(presignDocumentSchema), presignDocumentHandler);
documentRoutes.post('/', validateBody(registerDocumentSchema), registerDocumentHandler);
documentRoutes.delete('/:documentId', removeDocumentHandler);
