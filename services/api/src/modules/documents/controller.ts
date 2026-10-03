import type { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../../middleware/errors';
import { listDocuments, registerDocument, removeDocument, requestDocumentUpload } from './service';
import type { PresignDocumentInput, RegisterDocumentInput } from './schema';

export async function presignDocumentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new UnauthorizedError('UNAUTHENTICATED');
    const { contentType } = req.body as PresignDocumentInput;
    const upload = await requestDocumentUpload(req.user.id, req.params.auctionId as string, contentType);
    res.status(200).json(upload);
  } catch (err) {
    next(err);
  }
}

export async function registerDocumentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new UnauthorizedError('UNAUTHENTICATED');
    const document = await registerDocument(req.user.id, req.params.auctionId as string, req.body as RegisterDocumentInput);
    res.status(201).json({ document });
  } catch (err) {
    next(err);
  }
}

export async function listDocumentsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new UnauthorizedError('UNAUTHENTICATED');
    const documents = await listDocuments(req.user, req.params.auctionId as string);
    res.status(200).json({ documents });
  } catch (err) {
    next(err);
  }
}

export async function removeDocumentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new UnauthorizedError('UNAUTHENTICATED');
    await removeDocument(req.user.id, req.params.auctionId as string, req.params.documentId as string);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
