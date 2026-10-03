import type { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../../middleware/errors';
import {
  getStatsForAdmin,
  listAuctionsAsAdmin,
  listAuditLogForAdmin,
  listOrdersAsAdmin,
  listUsersForAdmin,
  moderateAuctionAsAdmin,
  setUserStatusAsAdmin,
} from './service';
import type {
  ListAdminAuctionsQuery,
  ListAdminOrdersQuery,
  ListAuditLogQuery,
  ListUsersQuery,
  ModerateAuctionInput,
  UpdateUserStatusInput,
} from './schema';

export async function listUsersHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { search, role, status, cursor, limit } = req.validatedQuery as ListUsersQuery;
    const result = await listUsersForAdmin(
      { ...(search ? { search } : {}), ...(role ? { role } : {}), ...(status ? { status } : {}) },
      limit,
      cursor,
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function updateUserStatusHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    const { status, reason } = req.body as UpdateUserStatusInput;
    const user = await setUserStatusAsAdmin(req.user.id, req.params.userId as string, status, reason);
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
}

export async function listAuditLogHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { targetType, targetId, cursor, limit } = req.validatedQuery as ListAuditLogQuery;
    const result = await listAuditLogForAdmin(
      { ...(targetType ? { targetType } : {}), ...(targetId ? { targetId } : {}) },
      limit,
      cursor,
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function listAuctionsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { status, search, cursor, limit } = req.validatedQuery as ListAdminAuctionsQuery;
    const result = await listAuctionsAsAdmin(
      { ...(status ? { status } : {}), ...(search ? { search } : {}) },
      limit,
      cursor,
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function moderateAuctionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    const { action, reason } = req.body as ModerateAuctionInput;
    const auction = await moderateAuctionAsAdmin(req.user.id, req.params.auctionId as string, action, reason);
    res.status(200).json({ auction });
  } catch (err) {
    next(err);
  }
}

export async function listOrdersHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { status, needsRefund, cursor, limit } = req.validatedQuery as ListAdminOrdersQuery;
    const result = await listOrdersAsAdmin(
      { ...(status ? { status } : {}), ...(needsRefund !== undefined ? { needsRefund: needsRefund === 'true' } : {}) },
      limit,
      cursor,
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function statsHandler(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json({ stats: await getStatsForAdmin() });
  } catch (err) {
    next(err);
  }
}
