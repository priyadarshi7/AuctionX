# 0015 — Frontend Foundation

## Context

`CLAUDE.md` Section 5 specifies the frontend stack (Next.js, React,
TypeScript, Tailwind, Zustand, TanStack Query, React Hook Form, Zod) but
leaves phase timing open — Section 73's numbered phases are entirely
backend through Phase 12. With Phases 1, 3, and 4 (auth, auctions,
bidding) functionally complete, the developer chose to start `apps/web`
now rather than wait for WebSockets (Phase 6), so there's something real to
click through.

## Problem

Four things needed a decision before the first page could be written: which
Next.js router (App vs Pages), where the access token lives given it can't
go in a cookie the same way the refresh token does, how Zustand and
TanStack Query divide responsibility, and whether to share Zod validation
schemas with the backend or duplicate them.

## Options Considered

### Router

1. **Pages Router** — the older, more mechanically simple model.
2. **App Router** (chosen) — Next.js's current default and recommended
   path for new projects; Server/Client Component split matches this app's
   actual shape (interactive, auth-gated content is client-rendered; the
   shell can stay server-rendered).

### Access token storage

1. **`localStorage`/`sessionStorage`** — persists across reloads, but is
   readable by any script running on the page, including an injected XSS
   payload (Section 28/29's explicit concern). Rejected outright.
2. **In-memory only (a Zustand store), recovered via silent refresh on
   load** (chosen) — never touchable by a same-page script that isn't part
   of the app's own bundle; the tradeoff (lost on hard reload) is exactly
   what the httpOnly refresh cookie (ADR-0003) already exists to solve.

### State split

1. **One state system for everything** — simpler on paper, but blurs two
   genuinely different kinds of state: "what did the server tell us"
   (auctions, bids — needs caching, refetching, invalidation) vs. "what do
   we know about this browser tab right now" (current user, access token).
2. **TanStack Query for server state, Zustand for client state** (chosen,
   matching Section 5's stack) — each tool does the one job it's actually
   good at; auth state doesn't need cache invalidation semantics, and
   server data doesn't belong in a hand-rolled store.

### Validation schema sharing

1. **Extract `packages/shared` now, share Zod schemas** — the "correct"
   long-term DRY answer, and Section 53 anticipates this package existing
   eventually.
2. **Duplicate the (currently two) small schemas in `apps/web`** (chosen)
   — standing up cross-workspace TypeScript project references to remove a
   few lines of duplication is more plumbing than the problem it solves,
   this early. A real refactor to make once more shapes need sharing, not
   a default to reach for on the first form.

## Decision

- `apps/web`: Next.js (App Router), TypeScript, Tailwind — scaffolded via
  `create-next-app`, workspace-named `@auctionx/web` to match `@auctionx/api`.
- `store/authStore.ts` (Zustand): `user`, `accessToken` (memory-only), and
  a `status` field (`idle | checking | authenticated | anonymous`) —
  `status` exists specifically so the UI can distinguish "haven't checked
  yet" from "checked, logged out," avoiding a flash of the wrong state on
  every load.
- `app/providers.tsx`: a `SilentRefresh` component runs once on mount,
  calling `POST /auth/refresh` (which authenticates via the httpOnly
  cookie, not a bearer token) to recover the session after a reload.
- `lib/apiClient.ts`: a thin `fetch` wrapper — `credentials: 'include'` on
  every call, structured `ApiError` mirroring the backend's error envelope
  (`middleware/errors.ts`) exactly.
- `lib/validation/auth.ts`: `loginSchema`/`registerSchema`, deliberately
  duplicated from `services/api/src/modules/auth/schema.ts`.
- `services/api/src/app.ts`'s CORS config changed from wildcard `cors()` to
  `cors({ origin: env.FRONTEND_URL, credentials: true })` — this is the
  moment flagged since AUTH-003 where "no frontend origin exists yet"
  stopped being true.
- Pages built: `/`, `/login`, `/register` — enough to prove register, login,
  logout, and silent-refresh-after-reload all work against the real API.

## Why

- **`status` as a fourth state, not a boolean `isLoggedIn`**: a boolean
  can't represent "don't know yet," which is the actual state for the
  first render of every page load until the silent-refresh request
  resolves. Collapsing it to `false` would render a wrong "logged out" UI
  for a moment, every time.
- **CORS fix now, not deferred further**: wildcard origin plus credentials
  is not even a combination browsers allow (Section 28's CORS/CSRF
  concerns are why this was flagged as a real gap, not a hypothetical one)
  — it had to be a specific origin the moment a specific origin existed to
  name.
- **`apiClient.ts` reflects the backend's error shape exactly, not its own
  shape**: a form's error message comes straight from the same structured
  `{code, message, details}` envelope every backend module already uses —
  no translation layer to keep in sync separately.

## Tradeoffs

```text
In-memory access token + silent refresh:
+ Immune to XSS reading it out of Web Storage
+ Reuses infrastructure that already exists (the refresh cookie, ADR-0003)
- One extra network round trip on every fresh page load before the UI
  knows if you're logged in (the `checking` state) — accepted; the
  alternative (persisted token) trades a real security property for it

Duplicated validation schemas:
+ Zero new build/workspace plumbing for the first two forms
- Two backend schema changes (e.g. a password rule change) require a
  matching frontend edit that nothing enforces automatically — an accepted
  gap until packages/shared is actually worth standing up
```

## Consequences

- Auction browsing, creation, and bidding UI are explicitly NOT part of
  this task — this is foundation only, proving the pipe works end to end.
  Those are next (WEB-001+).
- `npm install` needed to run once from the repo root after scaffolding
  (npm workspaces, one lockfile) — `create-next-app` was run with
  `--skip-install` for exactly this reason.
- Verified in a real headless browser (not just `curl`/unit tests): full
  register → auto-login → logout → login → hard-reload flow, confirming
  CORS+credentials actually work browser-side, not just in a test harness
  that doesn't enforce CORS.

## Revisit Conditions

- Extract `packages/shared` once a third form or a second consumer needs
  the same validation shape — not before.
- If access-token-loss-on-reload ever becomes a real UX complaint (not
  hypothetical), consider a short-lived, `httpOnly`-adjacent alternative —
  but the current tradeoff was chosen deliberately for its security
  property, not by default.
