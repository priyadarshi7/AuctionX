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
        className="relative rounded p-1 text-sm hover:text-gray-600"
        aria-label="Notifications"
      >
        Notifications
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-10 mt-2 w-80 rounded border border-gray-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
            <span className="text-sm font-medium">Notifications</span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => markAllRead.mutate()}
                disabled={markAllRead.isPending}
                className="text-xs text-gray-500 underline hover:text-gray-700 disabled:opacity-50"
              >
                Mark all read
              </button>
            )}
          </div>

          <ul className="max-h-96 overflow-y-auto">
            {notifications.length === 0 && <li className="px-3 py-4 text-sm text-gray-500">No notifications yet.</li>}
            {notifications.map((notification) => {
              const { message, href } = describeNotification(notification);
              const unread = !notification.readAt;
              return (
                <li key={notification.id} className={unread ? 'bg-blue-50' : undefined}>
                  <Link
                    href={href}
                    onClick={() => {
                      setOpen(false);
                      if (unread) {
                        markRead.mutate(notification.id);
                      }
                    }}
                    className="block border-b border-gray-100 px-3 py-2 text-sm hover:bg-gray-50"
                  >
                    <p>{message}</p>
                    <p className="mt-1 text-xs text-gray-400">{new Date(notification.createdAt).toLocaleString()}</p>
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
