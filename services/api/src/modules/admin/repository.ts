import type {
  AdminAuditLog,
  Auction,
  AuctionStatus,
  Order,
  OrderStatus,
  PaymentStatus,
  Prisma,
  Role,
  User,
  UserStatus,
} from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { SEARCH_EVENTS_TOPIC } from '../../infrastructure/kafka/topics';
import { createOutboxEventInTx } from '../../infrastructure/outbox/repository';

// (createdAt, id) keyset, same shape and reasoning as auctions' list
// (modules/auctions/repository.ts): createdAt alone isn't a strict order,
// and OFFSET pagination skips/repeats rows when the list changes between
// pages. Fetches limit+1 to learn whether another page exists without a
// separate COUNT.
export type Cursor = { createdAt: Date; id: string };

function keysetWhere(after?: Cursor) {
  return after
    ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] }
    : {};
}

export type UserListFilters = { search?: string; role?: Role; status?: UserStatus };

export async function listUsers(
  filters: UserListFilters,
  limit: number,
  after?: Cursor,
): Promise<{ rows: User[]; hasMore: boolean }> {
  const where: Prisma.UserWhereInput = {
    ...(filters.role ? { role: filters.role } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.search
      ? {
          OR: [
            { email: { contains: filters.search, mode: 'insensitive' } },
            { name: { contains: filters.search, mode: 'insensitive' } },
            // Exact id too: audit-log entries identify users by id, and "show
            // me this user" must work from there.
            { id: filters.search },
          ],
        }
      : {}),
    ...keysetWhere(after),
  };
  const rows = await prisma.user.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

// Grants or revokes "trusted seller" (ADR-0041): a trusted seller's
// low-risk listings skip the review queue. Same shape as changeUserStatus:
// guarded UPDATE + audit entry in one transaction, null when nothing
// changed (already in that state).
export async function changeTrustedSeller(
  actorId: string,
  targetId: string,
  trusted: boolean,
  reason: string | undefined,
): Promise<User | null> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.user.updateMany({
      where: { id: targetId, trustedSeller: { not: trusted } },
      data: { trustedSeller: trusted },
    });
    if (count === 0) return null;
    const user = await tx.user.findUniqueOrThrow({ where: { id: targetId } });
    await writeAuditEntryInTx(tx, {
      actorId,
      action: 'user.trusted_changed',
      targetType: 'user',
      targetId,
      reason,
      metadata: { from: !trusted, to: trusted },
    });
    return user;
  });
}

export function findUser(id: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id } });
}

export type NewAuditEntry = {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  reason?: string | undefined;
  metadata: Prisma.InputJsonValue;
};

export function writeAuditEntryInTx(tx: Prisma.TransactionClient, entry: NewAuditEntry): Promise<AdminAuditLog> {
  const { reason, ...rest } = entry;
  return tx.adminAuditLog.create({ data: { ...rest, ...(reason ? { reason } : {}) } });
}

// The status change and its audit entry commit together or not at all — an
// action with no record (or a record of an action that didn't happen) is
// exactly what an audit log must never contain. The guarded UPDATE
// (`status != new`) makes two admins issuing the same change at once
// produce one change and one entry, not two. Returns null when nothing
// changed (already in that status).
export async function changeUserStatus(
  actorId: string,
  targetId: string,
  status: UserStatus,
  reason: string | undefined,
): Promise<{ user: User; from: UserStatus } | null> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.user.findUnique({ where: { id: targetId }, select: { status: true } });
    if (!before) return null;
    const { count } = await tx.user.updateMany({
      where: { id: targetId, status: { not: status } },
      data: { status },
    });
    if (count === 0) return null;
    const user = await tx.user.findUniqueOrThrow({ where: { id: targetId } });
    await writeAuditEntryInTx(tx, {
      actorId,
      action: 'user.status_changed',
      targetType: 'user',
      targetId,
      reason,
      metadata: { from: before.status, to: status },
    });
    return { user, from: before.status };
  });
}

export type AuditLogFilters = { targetType?: string; targetId?: string };

export async function listAuditLog(
  filters: AuditLogFilters,
  limit: number,
  after?: Cursor,
): Promise<{ rows: AdminAuditLog[]; hasMore: boolean }> {
  const where: Prisma.AdminAuditLogWhereInput = {
    ...(filters.targetType ? { targetType: filters.targetType } : {}),
    ...(filters.targetId ? { targetId: filters.targetId } : {}),
    ...keysetWhere(after),
  };
  const rows = await prisma.adminAuditLog.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

// ---------------------------------------------------------------------------
// Auctions
// ---------------------------------------------------------------------------

export type AdminAuctionRow = Auction & { seller: { email: string; name: string }; _count: { bids: number } };

export async function listAuctionsForAdmin(
  filters: { status?: AuctionStatus; search?: string },
  limit: number,
  after?: Cursor,
): Promise<{ rows: AdminAuctionRow[]; hasMore: boolean }> {
  const where: Prisma.AuctionWhereInput = {
    // Drafts are the seller's private work in progress; an admin only sees a
    // listing once it has been submitted (PENDING_REVIEW) or gone live.
    status: filters.status && filters.status !== 'DRAFT' ? filters.status : { not: 'DRAFT' as const },
    ...(filters.search ? { title: { contains: filters.search, mode: 'insensitive' } } : {}),
    ...keysetWhere(after),
  };
  const rows = await prisma.auction.findMany({
    where,
    include: { seller: { select: { email: true, name: true } }, _count: { select: { bids: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

export type ModerationAction = 'pause' | 'resume' | 'cancel' | 'approve' | 'reject';

// Which states each action may start from, and where it lands. Cancel
// applies only to auctions that are (or were) live; a pending listing is
// decided with approve/reject instead. ENDED and CANCELLED auctions are
// final and cannot be moderated, since an ENDED one may already have an
// Order behind it.
const MODERATION_RULES: Record<ModerationAction, { from: AuctionStatus[]; to: AuctionStatus }> = {
  pause: { from: ['ACTIVE'], to: 'PAUSED' },
  resume: { from: ['PAUSED'], to: 'ACTIVE' },
  cancel: { from: ['PUBLISHED', 'ACTIVE', 'PAUSED'], to: 'CANCELLED' },
  // Review decisions (ADR-0041). Approve goes LIVE, with the clock starting
  // now from the duration the seller asked for; reject sends it back to
  // DRAFT with the admin's reason for the seller to fix and resubmit.
  approve: { from: ['PENDING_REVIEW'], to: 'ACTIVE' },
  reject: { from: ['PENDING_REVIEW'], to: 'DRAFT' },
};

export function allowedStatusesFor(action: ModerationAction): AuctionStatus[] {
  return MODERATION_RULES[action].from;
}

// Guarded transition: the allowed-source-state check lives in the UPDATE's
// WHERE, evaluated against the committed row, NOT in a prior read. The
// seller-facing pause/cancel do read-then-write; an admin click racing the
// closing worker could flip an ENDED auction (with an Order already created)
// to CANCELLED. Here that race simply matches nothing and returns null.
// Resume additionally requires the scheduled end to still be in the future
// (otherwise it would resume straight into the closing worker). The change,
// its audit entry, the search-reindex event and the seller notification
// event all commit together.
export async function moderateAuctionRow(
  actorId: string,
  auctionId: string,
  action: ModerationAction,
  reason: string | undefined,
): Promise<Auction | null> {
  const rule = MODERATION_RULES[action];
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const before = await tx.auction.findUnique({
      where: { id: auctionId },
      select: { status: true, sellerId: true, requestedDurationSeconds: true },
    });
    if (!before) return null;

    let extraWhere: Prisma.AuctionWhereInput = {};
    let extraData: Prisma.AuctionUpdateManyMutationInput = {};
    if (action === 'pause') {
      extraData = { heldByAdmin: true };
    } else if (action === 'resume') {
      extraWhere = { endTime: { gt: now } };
      extraData = { heldByAdmin: false };
    } else if (action === 'cancel') {
      extraData = { endedAt: now, heldByAdmin: false };
    } else if (action === 'approve') {
      // The clock starts NOW, at approval, from the duration the seller
      // chose: a listing that waited two days in the queue still gets its
      // full run. The duration is also pinned in the WHERE, so a seller who
      // withdraws and resubmits with a different duration between our read
      // and this write makes the update match nothing instead of applying
      // the stale one.
      const seconds = before.requestedDurationSeconds;
      if (seconds === null) return null;
      extraWhere = { requestedDurationSeconds: seconds };
      extraData = {
        startTime: now,
        endTime: new Date(now.getTime() + seconds * 1000),
        reviewedAt: now,
        reviewNote: null,
      };
    } else if (action === 'reject') {
      extraData = {
        reviewedAt: now,
        reviewNote: reason ?? null,
        requestedDurationSeconds: null,
        submittedAt: null,
      };
    }

    const { count } = await tx.auction.updateMany({
      where: { id: auctionId, status: { in: rule.from }, ...extraWhere },
      data: { status: rule.to, ...extraData },
    });
    if (count === 0) return null;

    const auction = await tx.auction.findUniqueOrThrow({ where: { id: auctionId } });
    await writeAuditEntryInTx(tx, {
      actorId,
      action: `auction.${action}`,
      targetType: 'auction',
      targetId: auctionId,
      reason,
      metadata: { from: before.status, to: rule.to },
    });
    await createOutboxEventInTx(tx, {
      topic: SEARCH_EVENTS_TOPIC,
      key: auctionId,
      payload: { type: 'auction.reindex', auctionId },
    });
    await createOutboxEventInTx(tx, {
      topic: 'auction-events',
      key: auctionId,
      payload: {
        type: 'auction.moderated',
        auctionId,
        sellerId: before.sellerId,
        action,
        reason: reason ?? null,
      },
    });
    return auction;
  });
}

export function findAuctionStatus(id: string): Promise<{ status: AuctionStatus; endTime: Date | null } | null> {
  return prisma.auction.findUnique({ where: { id }, select: { status: true, endTime: true } });
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export type AdminOrderRow = Order & {
  buyer: { email: string };
  seller: { email: string };
  payments: { status: PaymentStatus }[];
};

// "Needs a refund": the buyer's payment really succeeded but the order is
// CANCELLED (a payment landed after the deadline had cancelled it, ADR-0038).
// The money moved and nothing automatic will return it.
const NEEDS_REFUND_WHERE: Prisma.OrderWhereInput = {
  status: 'CANCELLED',
  payments: { some: { status: 'SUCCEEDED' } },
};

export async function listOrdersForAdmin(
  filters: { status?: OrderStatus; needsRefund?: boolean },
  limit: number,
  after?: Cursor,
): Promise<{ rows: AdminOrderRow[]; hasMore: boolean }> {
  const where: Prisma.OrderWhereInput = {
    ...(filters.needsRefund ? NEEDS_REFUND_WHERE : {}),
    ...(filters.status && !filters.needsRefund ? { status: filters.status } : {}),
    ...keysetWhere(after),
  };
  const rows = await prisma.order.findMany({
    where,
    include: {
      buyer: { select: { email: true } },
      seller: { select: { email: true } },
      payments: { select: { status: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export type PlatformStats = {
  users: { total: number; newLast7Days: number; restricted: number };
  auctions: Record<string, number>;
  bids: { total: number; last24Hours: number };
  orders: Record<string, number>;
  revenueCents: number;
  needsRefund: number;
  // When the longest-waiting listing was submitted, so the dashboard can show
  // how stale the review queue is.
  oldestPendingReviewAt: Date | null;
};

// All independent reads, issued concurrently: the cost is one round trip's
// latency, not the sum. Each is a cheap COUNT/GROUP BY; if any gets slow at
// scale it should move to a cached snapshot rather than be tuned here.
export async function getPlatformStats(now: Date): Promise<PlatformStats> {
  const day = 24 * 60 * 60 * 1000;
  const [users, newUsers, restricted, auctionsByStatus, bids, recentBids, ordersByStatus, revenue, needsRefund, oldestPending] =
    await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: new Date(now.getTime() - 7 * day) } } }),
      prisma.user.count({ where: { status: { not: 'ACTIVE' } } }),
      prisma.auction.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.bid.count(),
      prisma.bid.count({ where: { createdAt: { gte: new Date(now.getTime() - day) } } }),
      prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
      // Money actually collected and not cancelled: PAID, SHIPPED, DELIVERED.
      prisma.order.aggregate({
        where: { status: { in: ['PAID', 'SHIPPED', 'DELIVERED'] } },
        _sum: { amountCents: true },
      }),
      prisma.order.count({ where: NEEDS_REFUND_WHERE }),
      prisma.auction.aggregate({ where: { status: 'PENDING_REVIEW' }, _min: { submittedAt: true } }),
    ]);

  const toRecord = (rows: { status: string; _count: { _all: number } }[]) =>
    Object.fromEntries(rows.map((r) => [r.status, r._count._all]));

  return {
    users: { total: users, newLast7Days: newUsers, restricted },
    auctions: toRecord(auctionsByStatus),
    bids: { total: bids, last24Hours: recentBids },
    orders: toRecord(ordersByStatus),
    revenueCents: revenue._sum.amountCents ?? 0,
    needsRefund,
    oldestPendingReviewAt: oldestPending._min.submittedAt,
  };
}
