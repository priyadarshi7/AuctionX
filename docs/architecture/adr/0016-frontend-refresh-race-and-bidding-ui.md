# 0016 — Frontend Bidding UI, and a Real Refresh-Token Race It Surfaced

## Context

WEB-002 adds the write side of the frontend: creating an auction and
placing a bid. While verifying it end to end in a real browser, a genuine
concurrency bug surfaced in the auth flow built back in WEB-000 — not a
hypothetical one, an actual freshly-logged-in user getting silently logged
back out.

## Problem: chaining three backend lifecycle actions into one form

The backend deliberately keeps `create`, `publish`, and `start` as three
separate endpoints (ADR-0009/0010), each with its own reason to exist
independently (a real seller dashboard could offer them separately later).
But this simple frontend form has no such dashboard yet — a seller filling
out "create an auction" almost certainly wants it live immediately.

**Decision**: the create form's submit handler calls all three endpoints
in sequence (create → publish with a computed `endTime` → start), then
redirects to the detail page. If create succeeds but publish/start fails,
the error message includes a link to the now-real (if not-yet-published)
auction, rather than pretending nothing happened — there is no seller
dashboard yet to resume the job from, so honesty about the partial state is
the only reasonable option.

## Problem: a real, not hypothetical, refresh-token race

While verifying the bid flow, a freshly-logged-in bidder's session
silently vanished on the very next page load — no error shown, just back
to "Not logged in." The backend log showed two `/auth/refresh` requests
firing within milliseconds of each other, both presenting the same
pre-rotation cookie: the first rotated it successfully (200), the second —
presenting a token the first request had just revoked — was rejected
(401), and per ADR-0004's reuse-detection design, revoking a reused token
revokes the **entire session family**, which is exactly what happened.

The cause: `app/providers.tsx`'s `SilentRefresh` component runs its
refresh call inside a `useEffect` with no guard against React's Strict
Mode, which deliberately mounts effects twice in development specifically
to catch code that isn't safe to run twice. This effect wasn't safe to run
twice — and Strict Mode's whole purpose is to expose exactly that class of
bug before it reaches production.

### Options Considered

1. **Leave it — it's "just" a dev-mode artifact** — rejected. The
   underlying issue (two near-simultaneous refresh calls presenting the
   same token) is not actually dev-only. Two browser tabs opened moments
   apart would hit the identical race in production, with the identical
   consequence: both tabs logged out, having done nothing wrong.
2. **Fix it in the backend's rotation logic** (e.g., make the read-then-
   rotate sequence itself lock/serialize, the way bid placement does,
   ADR-0012) — the more complete fix, but a materially larger change to
   AUTH-004 territory, done reactively under a frontend task rather than
   as its own deliberate piece of work.
3. **Guard the effect with a `useRef`** (chosen) — a `hasStarted` ref
   ensures this component instance's refresh call only ever actually fires
   once, regardless of how many times Strict Mode invokes the effect.

## Decision

Added a `useRef` guard to `SilentRefresh`. The comment at the guard is
explicit about its actual scope: it prevents THIS component instance from
firing the call twice (fixing exactly the bug that was observed), but does
**not** protect against two separate browser tabs each independently
calling refresh at nearly the same moment — that remains a real, distinct,
unaddressed gap in the backend's rotation logic itself.

## Why

- **The ref guard is the correct, standard fix for this class of Strict
  Mode interaction** — not a workaround. React's own guidance for effects
  with genuinely non-idempotent side effects (this one exchanges and
  invalidates a credential) is exactly this pattern: make the side effect
  itself idempotent-per-mount, don't disable Strict Mode.
- **Not silently expanding this task into an AUTH-004 rewrite**: the
  multi-tab race is real, but fixing it properly (likely: locking the
  refresh-token read+rotate sequence, the same shape of fix ADR-0012
  already established for bids) deserves its own deliberate task with its
  own concurrency test — not a reactive patch bolted on while verifying an
  unrelated frontend feature.
- **Documented, not buried**: this is exactly the kind of finding Section
  36 wants demonstrated, not just asserted — caught by actually running
  the app, not by reading the code and guessing.

## Tradeoffs

```text
useRef guard on SilentRefresh:
+ Correctly fixes the exact bug observed (single-mount double-invocation)
+ Zero backend changes needed to ship this fix
- Does NOT fix the underlying multi-tab race — a real gap remains

Chaining create->publish->start in the frontend:
+ Matches what a seller using this simple form actually wants
+ No backend changes needed — reuses the existing three endpoints exactly
  as designed
- A failure between steps leaves a partially-live auction with no UI path
  to finish the job (no seller dashboard exists yet) — an accepted,
  temporary gap
```

## Consequences

- `lib/bidErrors.ts` translates backend error codes into bidder-facing
  copy (e.g., `VALIDATION_ERROR`'s literal "...current price of 6000
  cents" backend message becomes "Your bid must be higher than the
  current price.") — the first place in the frontend that error messages
  get deliberately reworded rather than shown as-is.
- The detail page (WEB-001) now polls every 5s while an auction is
  `ACTIVE` — an explicit, temporary stand-in for Phase 6's WebSockets,
  needed now that there's something worth watching change (another
  bidder's bid) in near-real-time.

## Revisit Conditions

- Fix the backend's refresh-rotation race properly (lock the read+rotate
  sequence, ADR-0004/0012's pattern) as its own task, informed by a real
  concurrent-refresh test — not speculatively, now that its existence is
  confirmed rather than theoretical.
- Once a seller dashboard exists (WEB-003+), reconsider whether create
  should still auto-publish, or whether that becomes the dashboard's job
  instead — this form's current behavior is a reasonable choice for "the
  only path that exists," not necessarily the final UX.
