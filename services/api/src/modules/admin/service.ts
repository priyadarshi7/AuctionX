import type { AdminAuditLog, Auction, AuctionStatus, Order, OrderStatus, Role, User, UserStatus } from '@prisma/client';
import { notifyAuctionChanged } from '../../infrastructure/realtime/auctionEvents';
import { clearUserBlocked, markUserBlocked } from '../../infrastructure/security/blockedUsers';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../middleware/errors';
import {
  changeTrustedSeller,
  changeUserStatus,
  findAuctionStatus,
  findUser,
  getPlatformStats,
  listAuctionsForAdmin,
  listAuditLog,
  listOrdersForAdmin,
  listUsers,
  moderateAuctionRow,
  type AdminAuctionRow,
  type AdminOrderRow,
  type AuditLogFilters,
  type Cursor,
  type ModerationAction,
  type PlatformStats,
  type UserListFilters,
} from './repository';

export type AdminUserView = {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  trustedSeller: boolean;
  emailVerifiedAt: Date | null;
  createdAt: Date;
};

// Never spreads the User row: passwordHash must not be one forgotten
// field away from leaking through an admin endpoint.
function toAdminUserView(user: User): AdminUserView {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    trustedSeller: user.trustedSeller,
    emailVerifiedAt: user.emailVerifiedAt,
    createdAt: user.createdAt,
  };
}

// Opaque to the client (same approach as auctions' cursors).
function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id })).toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { createdAt?: unknown; id?: unknown };
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('malformed cursor');
    }
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      throw new Error('malformed cursor timestamp');
    }
    return { createdAt, id: parsed.id };
  } catch {
    throw new ValidationError({ cursor: ['Invalid cursor'] });
  }
}

export async function listUsersForAdmin(
  filters: UserListFilters,
  limit: number,
  cursor?: string,
): Promise<{ users: AdminUserView[]; nextCursor: string | null }> {
  const { rows, hasMore } = await listUsers(filters, limit, cursor ? decodeCursor(cursor) : undefined);
  const last = rows.at(-1);
  return {
    users: rows.map(toAdminUserView),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

// Two guardrails that exist to keep admin power from locking everyone out
// or being turned on itself:
// - an admin can't moderate themselves (a typo'd click must not strand the
//   only admin);
// - an admin can't moderate another admin through this API — demoting an
//   admin is a deliberate out-of-band act (the make-admin script), so a
//   compromised admin session can't be used to ban the other admins.
// Setting a user to the status they already have is a success that changes
// and records nothing.
export async function setUserStatusAsAdmin(
  actorId: string,
  targetId: string,
  status: UserStatus,
  reason: string | undefined,
): Promise<AdminUserView> {
  const target = await findUser(targetId);
  if (!target) {
    throw new NotFoundError('User not found');
  }
  if (target.id === actorId) {
    throw new ForbiddenError('You cannot change your own account status', 'CANNOT_MODERATE_SELF');
  }
  if (target.role === 'ADMIN') {
    throw new ForbiddenError('Admin accounts cannot be moderated through the API', 'CANNOT_MODERATE_ADMIN');
  }

  const changed = await changeUserStatus(actorId, targetId, status, reason);
  if (changed) {
    // Take effect on already-issued access tokens too (see blockedUsers.ts).
    if (status === 'ACTIVE') await clearUserBlocked(targetId);
    else await markUserBlocked(targetId);
    return toAdminUserView(changed.user);
  }
  // Nothing changed: either already in that status, or deleted meanwhile.
  const latest = await findUser(targetId);
  if (!latest) {
    throw new NotFoundError('User not found');
  }
  return toAdminUserView(latest);
}

export type AuditLogEntryView = Pick<
  AdminAuditLog,
  'id' | 'actorId' | 'action' | 'targetType' | 'targetId' | 'reason' | 'metadata' | 'createdAt'
>;

export async function listAuditLogForAdmin(
  filters: AuditLogFilters,
  limit: number,
  cursor?: string,
): Promise<{ entries: AuditLogEntryView[]; nextCursor: string | null }> {
  const { rows, hasMore } = await listAuditLog(filters, limit, cursor ? decodeCursor(cursor) : undefined);
  const last = rows.at(-1);
  return {
    entries: rows,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

// ---------------------------------------------------------------------------
// Auctions
// ---------------------------------------------------------------------------

export type AdminAuctionView = Auction & {
  sellerEmail: string;
  sellerName: string;
  bidCount: number;
};

function toAdminAuctionView(row: AdminAuctionRow): AdminAuctionView {
  const { seller, _count, ...auction } = row;
  return { ...auction, sellerEmail: seller.email, sellerName: seller.name, bidCount: _count.bids };
}

export async function listAuctionsAsAdmin(
  filters: { status?: AuctionStatus; search?: string },
  limit: number,
  cursor?: string,
): Promise<{ auctions: AdminAuctionView[]; nextCursor: string | null }> {
  const { rows, hasMore } = await listAuctionsForAdmin(filters, limit, cursor ? decodeCursor(cursor) : undefined);
  const last = rows.at(-1);
  return {
    auctions: rows.map(toAdminAuctionView),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

const CONFLICT_CODE: Record<ModerationAction, string> = {
  pause: 'AUCTION_NOT_PAUSABLE',
  resume: 'AUCTION_NOT_RESUMABLE',
  cancel: 'AUCTION_NOT_CANCELLABLE',
  approve: 'AUCTION_NOT_REVIEWABLE',
  reject: 'AUCTION_NOT_REVIEWABLE',
};

const VERB_PAST: Record<ModerationAction, string> = {
  pause: 'paused',
  resume: 'resumed',
  cancel: 'cancelled',
  approve: 'approved',
  reject: 'rejected',
};

// Unlike a seller's own pause/cancel, an admin may act on ANY seller's
// auction, so there is no ownership check — the admin gate on the router is
// the authorization. The state rules still apply, enforced atomically in the
// repository; this layer only turns a "didn't apply" into the right error.
export async function moderateAuctionAsAdmin(
  actorId: string,
  auctionId: string,
  action: ModerationAction,
  reason: string | undefined,
): Promise<Auction> {
  const moderated = await moderateAuctionRow(actorId, auctionId, action, reason);
  if (moderated) {
    // After commit, same as every other lifecycle change: drop the cached
    // read and tell live watchers to refetch.
    await notifyAuctionChanged(auctionId, 'lifecycle');
    return moderated;
  }

  const current = await findAuctionStatus(auctionId);
  if (!current) {
    throw new NotFoundError('Auction not found');
  }
  if (action === 'resume' && current.status === 'PAUSED') {
    throw new ConflictError('AUCTION_SCHEDULE_EXPIRED', "This auction's scheduled end time has already passed");
  }
  throw new ConflictError(
    CONFLICT_CODE[action],
    `A ${current.status} auction cannot be ${VERB_PAST[action]}`,
  );
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export type AdminOrderView = Order & { buyerEmail: string; sellerEmail: string; needsRefund: boolean };

function toAdminOrderView(row: AdminOrderRow): AdminOrderView {
  const { buyer, seller, payments, ...order } = row;
  return {
    ...order,
    buyerEmail: buyer.email,
    sellerEmail: seller.email,
    needsRefund: order.status === 'CANCELLED' && payments.some((p) => p.status === 'SUCCEEDED'),
  };
}

export async function listOrdersAsAdmin(
  filters: { status?: OrderStatus; needsRefund?: boolean },
  limit: number,
  cursor?: string,
): Promise<{ orders: AdminOrderView[]; nextCursor: string | null }> {
  const { rows, hasMore } = await listOrdersForAdmin(filters, limit, cursor ? decodeCursor(cursor) : undefined);
  const last = rows.at(-1);
  return {
    orders: rows.map(toAdminOrderView),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function getStatsForAdmin(): Promise<PlatformStats> {
  return getPlatformStats(new Date());
}

// Marking a seller trusted lets their LOW-RISK listings skip review; it never
// bypasses the high-risk categories (reviewPolicy.ts). No-op success when
// they're already in that state, recording nothing.
export async function setTrustedSellerAsAdmin(
  actorId: string,
  targetId: string,
  trusted: boolean,
  reason: string | undefined,
): Promise<AdminUserView> {
  const target = await findUser(targetId);
  if (!target) {
    throw new NotFoundError('User not found');
  }
  const changed = await changeTrustedSeller(actorId, targetId, trusted, reason);
  if (changed) {
    return toAdminUserView(changed);
  }
  const latest = await findUser(targetId);
  if (!latest) {
    throw new NotFoundError('User not found');
  }
  return toAdminUserView(latest);
}
