import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';
import { verifyAccessToken } from '../security/tokens';
import { logger } from '../observability/logger';

// This gateway lives in the SAME process as the Express API (Section 14's
// diagram shows a logically separate "WebSocket Gateway," but extracting it
// into its own service is a Phase 12 decision that needs a real scaling/
// failure-boundary reason — Section 4 — and none exists yet at one-instance
// scale). It attaches to the same underlying `http.Server` `app.listen()`
// returns via the raw `upgrade` event, using `noServer: true` so it only
// claims the one path (`/ws`) it actually owns rather than hijacking every
// upgrade request on the server.
const WS_PATH = '/ws';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

// The browser's native WebSocket API cannot set an `Authorization` header on
// the handshake request, and the access token lives only in memory on the
// client (ADR-0015) — never a cookie, so there's nothing for the upgrade
// request itself to carry. The alternative (put the token in the `/ws?token=`
// query string) was rejected: URLs are far more likely than headers/bodies to
// end up in proxy/CDN/browser-history logs, and Section 34 says never log a
// token. Instead, a client that HAS a token may send an `auth` message to
// identify itself.
//
// Authentication is OPTIONAL, not required (revised from WS-001's original
// design — see ADR-0021): `GET /auctions/:id` is explicitly public
// (ADR-0008), and the frontend already lets an anonymous visitor watch an
// ACTIVE auction's live price. An anonymous viewer has no access token to
// send at all, so a mandatory-auth gate would have silently broken live
// updates for exactly the users Section 1 says should be able to "watch
// auctions." Nothing privileged happens over this channel — every message
// it carries is a contentless "something changed, go refetch over REST"
// signal, and REST re-enforces its own visibility rules independently — so
// there is no security property gained by forcing authentication before a
// client can subscribe.
const authMessageSchema = z.object({ type: z.literal('auth'), accessToken: z.string().min(1) });
const subscribeMessageSchema = z.object({ type: z.literal('subscribe'), auctionId: z.string().uuid() });
const unsubscribeMessageSchema = z.object({
  type: z.literal('unsubscribe'),
  auctionId: z.string().uuid(),
});
const clientMessageSchema = z.discriminatedUnion('type', [
  authMessageSchema,
  subscribeMessageSchema,
  unsubscribeMessageSchema,
]);

type ConnectionState = {
  authenticated: boolean;
  userId: string | undefined;
  subscriptions: Set<string>;
  isAlive: boolean;
};

// Close code 4000-4999 range is reserved for application use (RFC 6455).
// Only one application-specific case left now that auth is optional: a
// client that DID bother to send a token, but it was invalid/expired.
const CLOSE_INVALID_TOKEN = 4002;

let wss: WebSocketServer | undefined;
let heartbeatIntervalHandle: NodeJS.Timeout | undefined;
// Tracked explicitly so `stopWebSocketGateway` can remove exactly this
// listener from exactly this server. Without this, a start->stop->start
// cycle (every test in gateway.test.ts does one) would leave the OLD
// listener attached forever, stacking a duplicate `upgrade` handler on the
// server each time — Node invokes every registered listener for a given
// event, so a second attempt to `handleUpgrade` the same socket throws.
let attachedServer: Server | undefined;
let upgradeListener: ((req: IncomingMessage, socket: import('node:net').Socket, head: Buffer) => void) | undefined;
const connectionState = new Map<WebSocket, ConnectionState>();
// auctionId -> every currently-subscribed socket. Single-instance, in-memory
// only — Section 14 is explicit that this needs Redis Pub/Sub fanout once
// there is more than one gateway instance to broadcast across; premature
// today (Section 4) since nothing here scales horizontally yet.
const rooms = new Map<string, Set<WebSocket>>();
// userId -> every currently-connected socket authenticated as that user
// (a user can have more than one open tab/device). Unlike `rooms`, there is
// no explicit subscribe message for this — a client joins its own user room
// automatically the moment it successfully authenticates (see the `auth`
// branch in handleMessage), since "deliver my notifications to me" isn't an
// opt-in the way watching a specific auction is. Same single-instance,
// in-memory caveat as `rooms` above.
const userRooms = new Map<string, Set<WebSocket>>();

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendError(ws: WebSocket, code: string, message: string): void {
  send(ws, { type: 'error', code, message });
}

function subscribe(ws: WebSocket, state: ConnectionState, auctionId: string): void {
  state.subscriptions.add(auctionId);
  let room = rooms.get(auctionId);
  if (!room) {
    room = new Set();
    rooms.set(auctionId, room);
  }
  room.add(ws);
  send(ws, { type: 'subscribed', auctionId });
}

function unsubscribe(ws: WebSocket, state: ConnectionState, auctionId: string): void {
  state.subscriptions.delete(auctionId);
  const room = rooms.get(auctionId);
  room?.delete(ws);
  if (room && room.size === 0) {
    rooms.delete(auctionId);
  }
  send(ws, { type: 'unsubscribed', auctionId });
}

function joinUserRoom(ws: WebSocket, userId: string): void {
  let room = userRooms.get(userId);
  if (!room) {
    room = new Set();
    userRooms.set(userId, room);
  }
  room.add(ws);
}

function cleanupConnection(ws: WebSocket): void {
  const state = connectionState.get(ws);
  if (!state) {
    return;
  }
  for (const auctionId of state.subscriptions) {
    const room = rooms.get(auctionId);
    room?.delete(ws);
    if (room && room.size === 0) {
      rooms.delete(auctionId);
    }
  }
  if (state.userId) {
    const userRoom = userRooms.get(state.userId);
    userRoom?.delete(ws);
    if (userRoom && userRoom.size === 0) {
      userRooms.delete(state.userId);
    }
  }
  connectionState.delete(ws);
}

// `ws`'s message event hands back `Buffer | ArrayBuffer | Buffer[]` (the
// array case is a fragmented message's parts) — a plain `.toString()` on
// that union is exactly the kind of thing that silently produces
// "[object Object]" instead of the real content for the array/ArrayBuffer
// cases, which is why eslint's `no-base-to-string` rule flags a naive
// `data.toString()` here.
function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  return data.toString('utf8');
}

function handleMessage(ws: WebSocket, state: ConnectionState, raw: string): void {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    sendError(ws, 'INVALID_MESSAGE', 'Message must be valid JSON');
    return;
  }

  const result = clientMessageSchema.safeParse(parsedJson);
  if (!result.success) {
    sendError(ws, 'INVALID_MESSAGE', 'Unrecognized message shape');
    return;
  }
  const message = result.data;

  // `auth` is available at any time, not gated to "before anything else" —
  // a client identifying itself is optional metadata, not a precondition
  // for subscribe/unsubscribe (see the module comment on why). Re-sending it
  // after already succeeding is just re-verified and re-accepted rather than
  // treated as an error — a client that replays its own connect sequence
  // shouldn't be punished for it.
  if (message.type === 'auth') {
    try {
      const claims = verifyAccessToken(message.accessToken);
      state.authenticated = true;
      state.userId = claims.sub;
      joinUserRoom(ws, claims.sub);
      send(ws, { type: 'auth.ok' });
    } catch {
      // A client that bothered to present a token gets a clear signal its
      // token is bad, rather than being silently left unauthenticated — but
      // this never blocks it from subscribing anonymously afterward if it
      // reconnects, since subscribe never required auth in the first place.
      ws.close(CLOSE_INVALID_TOKEN, 'Invalid or expired access token');
    }
    return;
  }

  if (message.type === 'subscribe') {
    subscribe(ws, state, message.auctionId);
  } else if (message.type === 'unsubscribe') {
    unsubscribe(ws, state, message.auctionId);
  }
}

// Detects half-open connections (Section 14): a client whose TCP connection
// died without a clean close (phone locked, wifi dropped, laptop slept)
// leaves a socket that LOOKS open to us but will never receive anything
// again. `ws`'s ping/pong is the protocol-level mechanism for finding these —
// a healthy client's `ws` library answers a `ping` frame with a `pong` frame
// automatically, with no application code involved on the client side.
function startHeartbeat(intervalMs: number): void {
  heartbeatIntervalHandle = setInterval(() => {
    for (const [ws, state] of connectionState) {
      if (!state.isAlive) {
        // Missed the previous ping's pong entirely — assume dead and free
        // the resource. `terminate()`, not `close()`: a half-open socket
        // won't complete a clean close handshake either.
        ws.terminate();
        continue;
      }
      state.isAlive = false;
      ws.ping();
    }
  }, intervalMs);
}

export type WebSocketGatewayOptions = {
  heartbeatIntervalMs?: number;
};

export function startWebSocketGateway(server: Server, options: WebSocketGatewayOptions = {}): void {
  if (wss) {
    return;
  }
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  wss = new WebSocketServer({ noServer: true });

  upgradeListener = (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '', 'http://localhost');
    if (pathname !== WS_PATH) {
      // Not ours — Section 4 discipline: this gateway claims exactly one
      // path, it doesn't become the catch-all for every future upgrade
      // request on this server.
      socket.destroy();
      return;
    }
    wss?.handleUpgrade(req, socket, head, (ws) => {
      wss?.emit('connection', ws);
    });
  };
  attachedServer = server;
  server.on('upgrade', upgradeListener);

  wss.on('connection', (ws: WebSocket) => {
    const state: ConnectionState = {
      authenticated: false,
      userId: undefined,
      subscriptions: new Set(),
      isAlive: true,
    };
    connectionState.set(ws, state);
    logger.info({ event: 'ws.connected' }, 'WebSocket connection opened');

    ws.on('pong', () => {
      state.isAlive = true;
    });
    ws.on('message', (data: RawData) => {
      handleMessage(ws, state, rawDataToString(data));
    });
    ws.on('close', () => {
      logger.info(
        { event: 'ws.disconnected', userId: state.userId },
        'WebSocket connection closed',
      );
      cleanupConnection(ws);
    });
    ws.on('error', (err) => {
      logger.error({ err, event: 'ws.error' }, 'WebSocket connection error');
    });
  });

  startHeartbeat(heartbeatIntervalMs);
}

// Section 69's graceful shutdown, applied here: every open connection gets a
// clean 1001 ("going away") close frame — telling well-behaved clients this
// was a deliberate server shutdown, not a network failure, so they know to
// reconnect (and, later, to a possibly different instance) rather than
// treating it as an error.
export function stopWebSocketGateway(): void {
  if (heartbeatIntervalHandle) {
    clearInterval(heartbeatIntervalHandle);
    heartbeatIntervalHandle = undefined;
  }
  if (!wss) {
    return;
  }
  if (attachedServer && upgradeListener) {
    attachedServer.removeListener('upgrade', upgradeListener);
  }
  attachedServer = undefined;
  upgradeListener = undefined;
  for (const ws of connectionState.keys()) {
    ws.close(1001, 'Server shutting down');
  }
  wss.close();
  wss = undefined;
  connectionState.clear();
  rooms.clear();
  userRooms.clear();
}

// Called by `infrastructure/realtime/auctionEvents.ts`'s `notifyAuctionChanged`
// (WS-002, ADR-0021) after a bid is accepted or an auction's lifecycle state
// changes — never called directly from `bids`/`auctions` service code, so
// the decision of WHEN to notify stays in the domain modules while the
// mechanics of HOW fanout works stay here.
export function broadcastToAuction(auctionId: string, payload: unknown): void {
  const room = rooms.get(auctionId);
  if (!room) {
    return;
  }
  const message = JSON.stringify(payload);
  for (const ws of room) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

// Called by infrastructure/realtime/notificationEvents.ts after a
// Notification row commits. Best-effort only: if the user has no currently
// connected socket (or none that ever authenticated), this is a silent
// no-op — the Notification row itself, not this push, is what the user
// sees on their next visit (module comment on the Notification model).
export function pushToUser(userId: string, payload: unknown): void {
  const room = userRooms.get(userId);
  if (!room) {
    return;
  }
  const message = JSON.stringify(payload);
  for (const ws of room) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}
