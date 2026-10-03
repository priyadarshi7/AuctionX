import type { Auction, AuctionStatus, Role } from '@prisma/client';
import { getCachedAuction, setCachedAuction } from '../../infrastructure/redis/auctionCache';
import { notifyAuctionChanged } from '../../infrastructure/realtime/auctionEvents';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../middleware/errors';
import { findUserById } from '../auth/repository';
import {
  cancelAuctionRow,
  createAuction,
  findAuctionById,
  listAuctions,
  pauseAuctionRow,
  publishAuctionRow,
  startAuctionRow,
  updateAuctionRow,
  type AuctionCursor,
  type AuctionListFilters,
  type AuctionPatch,
} from './repository';
import type { CreateAuctionInput, ListAuctionsQuery, PublishAuctionInput, UpdateAuctionInput } from './schema';

export type RequestingUser = { id: string; role: Role } | undefined;

// No PublicAuction mapper here, unlike auth's toPublicUser — an Auction has
// no secret field to strip. sellerId is a public fact about a listing, not
// a credential.
export async function createNewAuction(sellerId: string, input: CreateAuctionInput): Promise<Auction> {
  // Soft email-verification gate (real product discussion, 2026-09-30):
  // browsing and logging in never require verification, but selling does.
  // Checked fresh from the DB, never trusted from the JWT — the access
  // token only carries {sub, role} (middleware/authenticate.ts) and can
  // outlive a verification that happened after it was issued, same
  // "never trust stale claims for security-relevant state" reasoning as
  // loginUser's user.status check.
  const seller = await findUserById(sellerId);
  if (!seller || !seller.emailVerifiedAt) {
    throw new ForbiddenError(
      'Verify your email before creating an auction',
      'EMAIL_NOT_VERIFIED',
    );
  }
  // Same stale-token reasoning as bids/service.ts's placeBid (ADR-0039).
  if (seller.status !== 'ACTIVE') {
    throw new ForbiddenError('Your account is not active', 'ACCOUNT_DISABLED');
  }

  // status and currentPriceCents are never taken from the client (Section
  // 82) — every auction is born DRAFT regardless of what the request body
  // said, and the current price starts equal to the starting price since no
  // bid exists yet.
  return createAuction({
    sellerId,
    title: input.title,
    description: input.description,
    category: input.category,
    condition: input.condition,
    images: input.images,
    startingPriceCents: input.startingPriceCents,
    ...(input.reservePriceCents !== undefined ? { reservePriceCents: input.reservePriceCents } : {}),
    currentPriceCents: input.startingPriceCents,
  });
}

// Opaque to the client by design — an implementation detail (which columns
// break ties, their order) that we don't want to commit to as a public
// contract. Base64url keeps it URL-safe without percent-encoding.
function encodeCursor(cursor: AuctionCursor): string {
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id })).toString(
    'base64url',
  );
}

function decodeCursor(raw: string): AuctionCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { createdAt?: unknown }).createdAt !== 'string' ||
      typeof (parsed as { id?: unknown }).id !== 'string'
    ) {
      throw new Error('malformed cursor payload');
    }
    const { createdAt, id } = parsed as { createdAt: string; id: string };
    const parsedDate = new Date(createdAt);
    if (Number.isNaN(parsedDate.getTime())) {
      throw new Error('malformed cursor timestamp');
    }
    return { createdAt: parsedDate, id };
  } catch {
    // A tampered or stale cursor is a client-input problem (400), not a
    // server error — same category as any other invalid request field.
    throw new ValidationError({ cursor: ['Invalid or corrupted cursor'] });
  }
}

// DRAFT auctions are only visible to their own seller or an admin (Section
// 21: admin/fraud review needs full visibility) — everyone else browsing or
// looking up someone else's listings should see exactly what a real buyer
// would see. Every other status is public: there's no enumeration-safety
// reason to hide PUBLISHED/ACTIVE/PAUSED/CANCELLED/ENDED auctions the way
// forgot-password hides account existence — auction ids aren't a secret,
// and a live marketplace's whole purpose is browsability.
function canSeeDraftsFor(user: RequestingUser, sellerIdFilter: string | undefined): boolean {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;
  return sellerIdFilter === user.id;
}

export async function listPublicAuctions(
  user: RequestingUser,
  query: ListAuctionsQuery,
): Promise<{ auctions: Auction[]; nextCursor: string | null }> {
  const allowDrafts = canSeeDraftsFor(user, query.sellerId);

  // A non-owner explicitly asking for status=DRAFT gets an empty page, not
  // an error — there's nothing to validate against (DRAFT is a legal enum
  // value), the caller just isn't allowed to see any results in that state,
  // same as a search that legitimately matches zero rows.
  if (query.status === 'DRAFT' && !allowDrafts) {
    return { auctions: [], nextCursor: null };
  }

  const filters: AuctionListFilters = {
    ...(query.category !== undefined ? { category: query.category } : {}),
    ...(query.sellerId !== undefined ? { sellerId: query.sellerId } : {}),
    ...(query.status !== undefined
      ? { status: query.status }
      : !allowDrafts
        ? { status: { not: 'DRAFT' } }
        : {}),
  };

  const after = query.cursor ? decodeCursor(query.cursor) : undefined;
  const { rows, hasMore } = await listAuctions(filters, query.limit, after);

  const lastRow = rows.at(-1);
  return {
    auctions: rows,
    nextCursor: hasMore && lastRow ? encodeCursor({ createdAt: lastRow.createdAt, id: lastRow.id }) : null,
  };
}

// Cache-aside (ADR-0017): one cache entry per auction, shared by every
// viewer regardless of role — the underlying row is identical for anyone
// allowed to see it at all, so visibility is checked AFTER retrieval,
// identically whether the row came from cache or Postgres. A cache miss
// (including a Redis outage) transparently falls back to the DB and
// re-populates the cache; nothing here can behave differently under a
// Redis failure than it did before this cache existed.
export async function getAuctionForViewer(user: RequestingUser, id: string): Promise<Auction> {
  const cached = await getCachedAuction(id);
  const auction = cached ?? (await findAuctionById(id));

  if (!auction) {
    throw new NotFoundError('Auction not found');
  }

  if (!cached) {
    await setCachedAuction(auction);
  }

  // A DRAFT auction hidden from a non-owner returns 404, identical to a
  // genuinely nonexistent id — this isn't hiding a secret (ids aren't
  // sensitive), it's simply not revealing that an unpublished listing with
  // this id exists yet, consistent with keeping DRAFT invisible everywhere
  // else in this module.
  if (auction.status === 'DRAFT' && !canSeeDraftsFor(user, auction.sellerId)) {
    throw new NotFoundError('Auction not found');
  }

  return auction;
}

// Ownership + visibility for a MUTATION attempt — reuses ADR-0008's
// visibility split rather than inventing a new one: a non-owner touching a
// DRAFT they can't even see gets 404 (identical to GET), because a 403
// here would leak that a specific, invisible auction exists. A non-owner
// touching anything else gets a real 403 — that auction's existence is
// already public via GET, so there's nothing left to protect by hiding it.
//
// Deliberately no admin bypass, unlike canSeeDraftsFor's read-side check —
// admin's role so far (AUTH-005) is account moderation, not editing listing
// content. Extending it here would be scope creep, not a stated requirement.
async function requireOwnedAuction(userId: string, auctionId: string): Promise<Auction> {
  const auction = await findAuctionById(auctionId);

  if (!auction || (auction.status === 'DRAFT' && auction.sellerId !== userId)) {
    throw new NotFoundError('Auction not found');
  }
  if (auction.sellerId !== userId) {
    throw new ForbiddenError('You do not own this auction');
  }

  return auction;
}

// Merges a proposed patch against the currently-stored row for both
// cross-field rules (reserve vs starting price, endTime vs startTime) — the
// Zod-level refine in schema.ts can only catch the case where BOTH sides of
// a rule are in the same request; a patch that only touches one side has to
// be checked against what's already in the database.
function validateMergedInvariants(auction: Auction, patch: UpdateAuctionInput): void {
  const effectiveStarting = patch.startingPriceCents ?? auction.startingPriceCents;
  const effectiveReserve = 'reservePriceCents' in patch ? patch.reservePriceCents : auction.reservePriceCents;
  if (effectiveReserve !== null && effectiveReserve !== undefined && effectiveReserve < effectiveStarting) {
    throw new ValidationError({
      reservePriceCents: ['reservePriceCents cannot be less than startingPriceCents'],
    });
  }

  const effectiveStart = patch.startTime ?? auction.startTime;
  const effectiveEnd = patch.endTime ?? auction.endTime;
  if (effectiveStart && effectiveEnd && effectiveEnd <= effectiveStart) {
    throw new ValidationError({ endTime: ['endTime must be after startTime'] });
  }
}

export async function updateExistingAuction(
  userId: string,
  auctionId: string,
  patch: UpdateAuctionInput,
): Promise<Auction> {
  const auction = await requireOwnedAuction(userId, auctionId);

  // Only a DRAFT auction is freely editable — once published, changing
  // price/description out from under anyone already watching would be
  // unfair, and the lifecycle (Section 17) treats every transition as a
  // deliberate gate, not something a plain edit should bypass.
  if (auction.status !== 'DRAFT') {
    throw new ConflictError('AUCTION_NOT_EDITABLE', 'Only a DRAFT auction can be edited');
  }

  validateMergedInvariants(auction, patch);

  const data: AuctionPatch = {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.category !== undefined ? { category: patch.category } : {}),
    ...(patch.condition !== undefined ? { condition: patch.condition } : {}),
    ...(patch.images !== undefined ? { images: patch.images } : {}),
    // currentPriceCents is kept in lockstep with startingPriceCents here —
    // a DRAFT can never have a real bid yet (bidding requires ACTIVE), so
    // "the current price to beat" is ALWAYS exactly the starting price
    // until the first bid ever lands. Found live (2026-09-29): without
    // this, editing a DRAFT's price (SetPriceAndPublishPanel, ADR-0032's
    // create-flow restructure) left currentPriceCents at whatever value
    // the auction was created with, which is the real number bid
    // validation checks against — a serious bug, not cosmetic.
    ...(patch.startingPriceCents !== undefined
      ? { startingPriceCents: patch.startingPriceCents, currentPriceCents: patch.startingPriceCents }
      : {}),
    // Cast is safe: the `in` check proves the key was actually sent, so the
    // value is a real number or an explicit null, never `undefined` — the
    // static type just can't express that narrowing on its own.
    ...('reservePriceCents' in patch ? { reservePriceCents: patch.reservePriceCents as number | null } : {}),
    ...(patch.startTime !== undefined ? { startTime: patch.startTime } : {}),
    ...(patch.endTime !== undefined ? { endTime: patch.endTime } : {}),
  };

  const updated = await updateAuctionRow(auctionId, data);
  await notifyAuctionChanged(auctionId, 'lifecycle');
  return updated;
}

export async function publishExistingAuction(
  userId: string,
  auctionId: string,
  input: PublishAuctionInput,
): Promise<Auction> {
  const auction = await requireOwnedAuction(userId, auctionId);

  if (auction.status !== 'DRAFT') {
    throw new ConflictError('AUCTION_NOT_PUBLISHABLE', 'Only a DRAFT auction can be published');
  }

  // startTime defaults to "now" if the seller never scheduled one — the
  // common case of "publish and start the countdown immediately." endTime
  // has no such default: an auction with no defined end is a bid pipeline
  // (Section 10) with nothing to close, so it must be explicitly known by
  // the time of publish, whether set here or via a prior update.
  const startTime = input.startTime ?? auction.startTime ?? new Date();
  const endTime = input.endTime ?? auction.endTime;

  if (!endTime) {
    throw new ValidationError({ endTime: ['endTime is required to publish an auction'] });
  }
  if (endTime <= startTime) {
    throw new ValidationError({ endTime: ['endTime must be after startTime'] });
  }
  if (endTime <= new Date()) {
    throw new ValidationError({ endTime: ['endTime must be in the future'] });
  }

  const published = await publishAuctionRow(auctionId, { startTime, endTime });
  await notifyAuctionChanged(auctionId, 'lifecycle');
  return published;
}

// Section 73's Phase 3 action list has `pause` but no separate "resume" —
// `start` fills that role too: valid from PUBLISHED (first activation) OR
// PAUSED (resuming), rather than inventing an unlisted verb for the latter.
const STARTABLE_STATUSES: AuctionStatus[] = ['PUBLISHED', 'PAUSED'];

// Any non-terminal state can be cancelled, including DRAFT — a formal
// "I'm abandoning this listing" is preferable to just leaving a stale DRAFT
// row around forever, and it's consistent with never hard-deleting an
// auction (ADR-0007's onDelete: Restrict reasoning: it's a business record).
const CANCELLABLE_STATUSES: AuctionStatus[] = ['DRAFT', 'PUBLISHED', 'ACTIVE', 'PAUSED'];

export async function startExistingAuction(userId: string, auctionId: string): Promise<Auction> {
  const auction = await requireOwnedAuction(userId, auctionId);

  if (!STARTABLE_STATUSES.includes(auction.status)) {
    throw new ConflictError('AUCTION_NOT_STARTABLE', 'Only a PUBLISHED or PAUSED auction can be started');
  }
  // Nothing in this request is malformed — there's no request body at all —
  // so a stale schedule is a state conflict (409), not a validation error.
  // Fixing it (cancel and relist, or a future reschedule action) is out of
  // scope for this task.
  if (!auction.endTime || auction.endTime <= new Date()) {
    throw new ConflictError(
      'AUCTION_SCHEDULE_EXPIRED',
      "This auction's scheduled end time has already passed",
    );
  }

  const started = await startAuctionRow(auctionId);
  await notifyAuctionChanged(auctionId, 'lifecycle');
  return started;
}

export async function pauseExistingAuction(userId: string, auctionId: string): Promise<Auction> {
  const auction = await requireOwnedAuction(userId, auctionId);

  if (auction.status !== 'ACTIVE') {
    throw new ConflictError('AUCTION_NOT_PAUSABLE', 'Only an ACTIVE auction can be paused');
  }

  const paused = await pauseAuctionRow(auctionId);
  await notifyAuctionChanged(auctionId, 'lifecycle');
  return paused;
}

export async function cancelExistingAuction(userId: string, auctionId: string): Promise<Auction> {
  const auction = await requireOwnedAuction(userId, auctionId);

  if (!CANCELLABLE_STATUSES.includes(auction.status)) {
    throw new ConflictError('AUCTION_NOT_CANCELLABLE', 'This auction can no longer be cancelled');
  }

  const cancelled = await cancelAuctionRow(auctionId);
  await notifyAuctionChanged(auctionId, 'lifecycle');
  return cancelled;
}
