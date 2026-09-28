import type { Order } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';

export function findOrderById(id: string): Promise<Order | null> {
  return prisma.order.findUnique({ where: { id } });
}

// A buyer and a seller are both legitimate viewers of the same order, from
// opposite sides — one query, OR'd, rather than two separate endpoints.
export function listOrdersForUser(userId: string): Promise<Order[]> {
  return prisma.order.findMany({
    where: { OR: [{ buyerId: userId }, { sellerId: userId }] },
    orderBy: { createdAt: 'desc' },
  });
}
