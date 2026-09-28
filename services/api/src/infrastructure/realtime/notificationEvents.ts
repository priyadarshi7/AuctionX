import { pushToUser } from '../websocket/gateway';
import type { Notification } from '@prisma/client';

// Called by modules/notifications/service.ts AFTER the Notification row's
// transaction has committed — never before, and never as a substitute for
// it (see the Notification model's doc comment). The payload carries the
// full notification, unlike notifyAuctionChanged's contentless "go
// refetch" signal: a notification is per-user, low-volume, and its data is
// small enough that there's no risk of it drifting out of sync with a
// separately-fetched REST copy the way a whole auction's mutable state
// could.
export function pushNotification(notification: Notification): void {
  pushToUser(notification.userId, { type: 'notification.new', notification });
}
