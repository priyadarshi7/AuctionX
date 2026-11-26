'use client';

import { IconBell } from '@tabler/icons-react';
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

  // Closes the dropdown on an outside click or Escape — a bare `open` toggle
  // with no dismissal would otherwise trap it open until clicked again.
  useEffect(() => {
    if (!open) return;
    function handleClick(event: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  if (status !== 'authenticated') {
    return null;
  }

  const notifications = notificationsQuery.data?.notifications ?? [];
  const unreadCount = notificationsQuery.data?.unreadCount ?? 0;

  return (
    <div ref={containerRef} className="sm:relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        className="relative flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <IconBell className="size-4.5" stroke={1.6} />
        {unreadCount > 0 && (
          <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-background">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute inset-x-3 top-14 z-50 overflow-hidden rounded-2xl border border-border-strong bg-primitive-surface-overlay shadow-2xl sm:inset-x-auto sm:right-0 sm:top-11 sm:w-88">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="text-sm font-medium">Notifications</span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => markAllRead.mutate()}
                disabled={markAllRead.isPending}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                Mark all read
              </button>
            )}
          </div>

          <ul className="max-h-96 overflow-y-auto">
            {notifications.length === 0 && (
              <li className="px-4 py-10 text-center text-sm text-muted-foreground">You&apos;re all caught up.</li>
            )}
            {notifications.map((notification) => {
              const { message, href } = describeNotification(notification);
              const unread = !notification.readAt;
              return (
                <li key={notification.id} className="border-b border-border last:border-b-0">
                  <Link
                    href={href}
                    onClick={() => {
                      setOpen(false);
                      if (unread) {
                        markRead.mutate(notification.id);
                      }
                    }}
                    className="flex gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted"
                  >
                    <span
                      aria-hidden
                      className={`mt-1.5 size-1.5 shrink-0 rounded-full ${unread ? 'bg-accent' : 'bg-transparent'}`}
                    />
                    <span className="min-w-0">
                      <span className={`block ${unread ? 'text-foreground' : 'text-muted-foreground'}`}>{message}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {new Date(notification.createdAt).toLocaleString()}
                      </span>
                      {unread && <span className="sr-only">Unread</span>}
                    </span>
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
