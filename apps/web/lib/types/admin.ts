// Mirrors services/api/src/modules/admin (service.ts view types). Dates are
// ISO strings once they cross HTTP, same note as lib/types/auction.ts.
import type { Auction, AuctionStatus } from './auction';
import type { Order, OrderStatus } from './order';

export type UserRole = 'USER' | 'ADMIN';
export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'BANNED';

export type AdminUser = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  trustedSeller: boolean;
  emailVerifiedAt: string | null;
  createdAt: string;
};

export type AdminAuction = Auction & { sellerEmail: string; sellerName: string; bidCount: number };

export type AdminOrder = Order & { buyerEmail: string; sellerEmail: string; needsRefund: boolean };

export type AuditEntry = {
  id: string;
  // null: done outside the API (the make-admin CLI).
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type PlatformStats = {
  users: { total: number; newLast7Days: number; restricted: number };
  auctions: Partial<Record<AuctionStatus, number>>;
  bids: { total: number; last24Hours: number };
  orders: Partial<Record<OrderStatus, number>>;
  revenueCents: number;
  needsRefund: number;
  oldestPendingReviewAt: string | null;
};

export type Paged<K extends string, T> = { [P in K]: T[] } & { nextCursor: string | null };

export type ModerationAction = 'pause' | 'resume' | 'cancel' | 'approve' | 'reject';
