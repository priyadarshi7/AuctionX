import type { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../../middleware/errors';
import { requestUploadUrl } from './service';
import type { PresignUploadInput } from './schema';

export async function presignUploadHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    const { contentType } = req.body as PresignUploadInput;
    const presigned = await requestUploadUrl(req.user.id, contentType);
    res.status(200).json(presigned);
  } catch (err) {
    next(err);
  }
}
