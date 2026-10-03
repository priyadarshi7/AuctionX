import { apiFetch } from './apiClient';
import type {
  AdminAuction,
  AdminOrder,
  AdminUser,
  AuditEntry,
  ModerationAction,
  Paged,
  PlatformStats,
  UserRole,
  UserStatus,
} from './types/admin';
import type { Auction, AuctionStatus } from './types/auction';
import type { OrderStatus } from './types/order';

const PAGE_SIZE = 20;

export function getStatsRequest(accessToken: string): Promise<{ stats: PlatformStats }> {
  return apiFetch('/admin/stats', { accessToken });
}

export function listUsersRequest(
  accessToken: string,
  filters: { search?: string; role?: UserRole; status?: UserStatus },
  cursor?: string,
): Promise<Paged<'users', AdminUser>> {
  return apiFetch('/admin/users', { accessToken, query: { ...filters, cursor, limit: PAGE_SIZE } });
}

export function setUserStatusRequest(
  accessToken: string,
  userId: string,
  status: UserStatus,
  reason?: string,
): Promise<{ user: AdminUser }> {
  return apiFetch(`/admin/users/${userId}/status`, {
    method: 'PATCH',
    accessToken,
    body: { status, ...(reason ? { reason } : {}) },
  });
}

export function setTrustedSellerRequest(
  accessToken: string,
  userId: string,
  trusted: boolean,
  reason?: string,
): Promise<{ user: AdminUser }> {
  return apiFetch(`/admin/users/${userId}/trusted`, {
    method: 'PATCH',
    accessToken,
    body: { trusted, ...(reason ? { reason } : {}) },
  });
}

export function listAuctionsRequest(
  accessToken: string,
  filters: { search?: string; status?: AuctionStatus },
  cursor?: string,
): Promise<Paged<'auctions', AdminAuction>> {
  return apiFetch('/admin/auctions', { accessToken, query: { ...filters, cursor, limit: PAGE_SIZE } });
}

export function moderateAuctionRequest(
  accessToken: string,
  auctionId: string,
  action: ModerationAction,
  reason?: string,
): Promise<{ auction: Auction }> {
  return apiFetch(`/admin/auctions/${auctionId}/moderate`, {
    method: 'POST',
    accessToken,
    body: { action, ...(reason ? { reason } : {}) },
  });
}

export function listOrdersAdminRequest(
  accessToken: string,
  filters: { status?: OrderStatus; needsRefund?: boolean },
  cursor?: string,
): Promise<Paged<'orders', AdminOrder>> {
  return apiFetch('/admin/orders', {
    accessToken,
    query: {
      status: filters.status,
      needsRefund: filters.needsRefund ? 'true' : undefined,
      cursor,
      limit: PAGE_SIZE,
    },
  });
}

export function listAuditLogRequest(
  accessToken: string,
  cursor?: string,
  limit = PAGE_SIZE,
): Promise<Paged<'entries', AuditEntry>> {
  return apiFetch('/admin/audit-log', { accessToken, query: { cursor, limit } });
}
