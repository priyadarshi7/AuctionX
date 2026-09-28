'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

// The backend serves the WebSocket gateway on the same host as the REST
// API, at `/ws` rather than under `/api/v1` (services/api's app.ts mounts
// it on the raw http.Server, not inside the Express app). Derived from the
// same env var apiClient.ts already uses rather than a second one, so the
// two can't drift apart if the API's origin ever changes.
function deriveWsUrl(): string {
  const apiUrl = new URL(API_BASE_URL);
  const wsProtocol = apiUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProtocol}//${apiUrl.host}/ws`;
}

const BASE_RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

function isAuctionChangedMessage(data: unknown): data is { type: 'auction.changed'; auctionId: string } {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'auction.changed';
}

// Live updates for one auction's detail page — replaces ADR-0016's 5s-poll
// stand-in now that the backend's WebSocket gateway (ADR-0020/0021) exists.
// The message this channel carries has no auction data in it at all, only a
// signal that something changed; on receiving one, this just invalidates the
// same TanStack Query keys the polling version refetched, letting the
// existing REST fetch logic (and its visibility rules, ADR-0008) stay the
// single source of truth for what the data actually looks like.
//
// Deliberately connects even for an anonymous viewer (`accessToken` may be
// null): `GET /auctions/:id` is public, and the gateway doesn't require
// authentication to subscribe (ADR-0021) — an anonymous visitor watching a
// live auction is a real, intended use case (Section 1), not an edge case.
export function useAuctionSocket(auctionId: string, enabled: boolean, accessToken: string | null): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) {
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
        // Best-effort identification only — never a precondition for
        // subscribing (ADR-0021). Sent before `subscribe` purely so the
        // connection is attributable in server logs from the start if it IS
        // going to identify itself at all.
        if (accessToken) {
          ws?.send(JSON.stringify({ type: 'auth', accessToken }));
        }
        ws?.send(JSON.stringify({ type: 'subscribe', auctionId }));
      });

      ws.addEventListener('message', (event: MessageEvent<string>) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          return;
        }
        if (isAuctionChangedMessage(parsed) && parsed.auctionId === auctionId) {
          void queryClient.invalidateQueries({ queryKey: ['auctions', 'detail', auctionId] });
          void queryClient.invalidateQueries({ queryKey: ['auctions', 'bids', auctionId] });
        }
      });

      // A clean server-initiated shutdown (close code 1001) and a dropped
      // network connection both land here identically — nothing on the
      // client can reliably tell them apart, so both get the same retry
      // treatment. Reconnecting isn't optional (Section 14 lists it
      // explicitly): without it, one dropped connection would silently
      // freeze this page's live updates for the rest of the session, with
      // no visible error to explain why. Capped exponential backoff (2s,
      // 4s, 8s... up to 30s) avoids hammering the server with reconnect
      // attempts if it's down for longer than a moment.
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
  }, [auctionId, enabled, accessToken, queryClient]);
}
