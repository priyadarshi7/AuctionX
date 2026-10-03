import { AuctionStatus, OrderStatus, Role, UserStatus } from '@prisma/client';
import { z } from 'zod';

export const listUsersQuerySchema = z.object({
  // Matches email or name, case-insensitive substring.
  search: z.string().trim().min(1).max(100).optional(),
  role: z.nativeEnum(Role).optional(),
  status: z.nativeEnum(UserStatus).optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

// A reason is mandatory when taking access away: it goes into the audit log,
// and "who banned this person, and why" must always have an answer.
// Reinstating (ACTIVE) may omit it.
export const updateUserStatusSchema = z
  .object({
    status: z.nativeEnum(UserStatus),
    reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(500).optional(),
  })
  .refine((data) => data.status === 'ACTIVE' || !!data.reason, {
    message: 'A reason is required to suspend or ban a user',
    path: ['reason'],
  });
export type UpdateUserStatusInput = z.infer<typeof updateUserStatusSchema>;

export const listAuditLogQuerySchema = z.object({
  targetType: z.string().trim().min(1).max(50).optional(),
  targetId: z.string().trim().min(1).max(100).optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListAuditLogQuery = z.infer<typeof listAuditLogQuerySchema>;

export const listAdminAuctionsQuerySchema = z.object({
  status: z.nativeEnum(AuctionStatus).optional(),
  // Matches the auction title, case-insensitive substring.
  search: z.string().trim().min(1).max(100).optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListAdminAuctionsQuery = z.infer<typeof listAdminAuctionsQuerySchema>;

// pause / cancel take a user's auction offline, so they need a reason (it
// goes into the audit log and to the seller); resume doesn't.
export const moderateAuctionSchema = z
  .object({
    action: z.enum(['pause', 'resume', 'cancel']),
    reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(500).optional(),
  })
  .refine((data) => data.action === 'resume' || !!data.reason, {
    message: 'A reason is required to pause or cancel an auction',
    path: ['reason'],
  });
export type ModerateAuctionInput = z.infer<typeof moderateAuctionSchema>;

export const listAdminOrdersQuerySchema = z.object({
  status: z.nativeEnum(OrderStatus).optional(),
  // Only orders that were cancelled after the buyer's payment succeeded.
  needsRefund: z.enum(['true', 'false']).optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListAdminOrdersQuery = z.infer<typeof listAdminOrdersQuerySchema>;
