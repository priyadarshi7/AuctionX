'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

function deriveWsUrl(): string {
  const apiUrl = new URL(API_BASE_URL);
  const wsProtocol = apiUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProtocol}//${apiUrl.host}/ws`;
}

const BASE_RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

function isNotificationMessage(data: unknown): data is { type: 'notification.new' } {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'notification.new';
}

// App-wide, not page-scoped like useAuctionSocket — mounted once from
// NavBar.tsx (present in the root layout, so this connection persists
// across page navigation for the lifetime of an authenticated session).
// Unlike useAuctionSocket, this ALWAYS sends `auth` and never `subscribe`:
// the backend gateway auto-joins an authenticated connection to its own
// per-user room (infrastructure/websocket/gateway.ts's `joinUserRoom`) —
// there's no separate per-notification-type subscribe step, since a user
// either wants their own notifications delivered live or doesn't connect
// at all (this hook is disabled entirely while anonymous).
//
// The pushed message carries no notification data of its own (same
// contentless-signal pattern as useAuctionSocket) — on receipt this just
// invalidates the notifications query, letting the existing REST fetch
// (with its own auth/ownership checks) stay the single source of truth
// for what the list actually contains.
export function useNotificationSocket(enabled: boolean, accessToken: string | null): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled || !accessToken) {
      return;
    }

    let closedByCleanup = false;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let ws: WebSocket | undefined;

    function connect(): void {
      ws = new WebSocket(deriveWsUrl());

      ws.addEventListener('open', () => {
        reconnectAttempt = 0;
        ws?.send(JSON.stringify({ type: 'auth', accessToken }));
      });

      ws.addEventListener('message', (event: MessageEvent<string>) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          return;
        }
        if (isNotificationMessage(parsed)) {
          void queryClient.invalidateQueries({ queryKey: ['notifications'] });
        }
      });

      // Same reconnect-with-backoff reasoning as useAuctionSocket — a
      // dropped connection must not silently end live notification
      // delivery for the rest of the session.
      ws.addEventListener('close', () => {
        if (closedByCleanup) {
          return;
        }
        const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY_MS);
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      });
    }

    connect();

    return () => {
      closedByCleanup = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      ws?.close();
    };
  }, [enabled, accessToken, queryClient]);
}
