'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  describeNotification,
  listMyNotificationsRequest,
  markAllNotificationsReadRequest,
  markNotificationReadRequest,
} from '@/lib/notifications';
import { useNotificationSocket } from '@/lib/useNotificationSocket';
import { useAuthStore } from '@/store/authStore';

export function NotificationBell() {
  const status = useAuthStore((state) => state.status);
  const accessToken = useAuthStore((state) => state.accessToken);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useNotificationSocket(status === 'authenticated', accessToken);

  const notificationsQuery = useQuery({
    queryKey: ['notifications'],
    queryFn: () => listMyNotificationsRequest(accessToken!),
    enabled: status === 'authenticated' && !!accessToken,
  });

  const markRead = useMutation({
    mutationFn: (notificationId: string) => markNotificationReadRequest(accessToken!, notificationId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const markAllRead = useMutation({
    mutationFn: () => markAllNotificationsReadRequest(accessToken!),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  // Closes the dropdown on an outside click — a bare `open` toggle with no
  // dismissal would otherwise trap it open until the bell is clicked again.
  useEffect(() => {
    if (!open) return;
    function handleClick(event: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  if (status !== 'authenticated') {
    return null;
  }

  const notifications = notificationsQuery.data?.notifications ?? [];
  const unreadCount = notificationsQuery.data?.unreadCount ?? 0;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="relative flex h-8 w-8 items-center justify-center rounded-full border-2 border-line bg-white text-sm hover:bg-cream-2"
        aria-label="Notifications"
      >
        {'\u{1F514}'}
        {unreadCount > 0 && (
          <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full border border-line bg-pink px-1 text-[10px] font-semibold text-ink">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-10 mt-2 w-80 rounded-2xl border-2 border-line bg-white shadow-hard">
          <div className="flex items-center justify-between border-b-2 border-line px-3 py-2">
            <span className="font-display text-sm font-bold">Notifications</span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => markAllRead.mutate()}
                disabled={markAllRead.isPending}
                className="text-xs font-medium text-ink/60 underline hover:text-ink disabled:opacity-50"
              >
                Mark all read
              </button>
            )}
          </div>

          <ul className="max-h-96 overflow-y-auto">
            {notifications.length === 0 && <li className="px-3 py-4 text-sm text-ink/50">No notifications yet.</li>}
            {notifications.map((notification) => {
              const { message, href } = describeNotification(notification);
              const unread = !notification.readAt;
              return (
                <li key={notification.id} className={unread ? 'bg-yellow/20' : undefined}>
                  <Link
                    href={href}
                    onClick={() => {
                      setOpen(false);
                      if (unread) {
                        markRead.mutate(notification.id);
                      }
                    }}
                    className="block border-b border-line/10 px-3 py-2 text-sm hover:bg-cream-2"
                  >
                    <p>{message}</p>
                    <p className="mt-1 text-xs text-ink/40">{new Date(notification.createdAt).toLocaleString()}</p>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
