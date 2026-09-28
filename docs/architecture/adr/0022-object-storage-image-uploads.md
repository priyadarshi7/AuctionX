# 0022 — Object Storage for Auction Images (Presigned Uploads)

## Context

Section 27 called for object storage since AUCTION-001 (`Auction.images`
has always been a `String[]`), but it was never built — the column
defaulted to `[]` and the create-auction form had no way to add a photo at
all. This is a real product gap: Section 1 lists "upload images/videos" as
a core feature, and an auction marketplace where no listing can show a
photo of the actual item is missing something buyers genuinely need.

## Decision 1: Cloudflare R2 (S3-compatible), not Cloudinary

Asked directly before building anything. Cloudinary offers real ergonomic
wins (built-in image transforms via URL params, a simpler upload widget),
but it's a proprietary API with no self-hosted equivalent — using it would
mean local development depends on a live third-party account, breaking the
same principle that already ruled out anything but fully self-hosted
Postgres/Redis for local dev (Section 83: "the system never *requires* a
live deployment to develop against"). R2 + a generic S3 client keeps that
principle intact: MinIO/whatever local stand-in speaks the identical API
R2 does, so `infrastructure/storage/s3Client.ts` never branches on
environment. Chosen with the developer's explicit agreement.

## Decision 2: the local stand-in, after two real dead ends

Section 27/83 already named MinIO as the obvious local S3-compatible
choice. It didn't work:

1. **MinIO** — `docker pull minio/minio` returns "access denied." Tried
   every public mirror (Docker Hub, `quay.io/minio/minio`,
   `ghcr.io/minio/minio`): all denied. MinIO restricted anonymous
   distribution of their images at some point after this project's
   CLAUDE.md was written — a real, current change, not a local
   misconfiguration (confirmed by testing multiple specific pinned tags,
   not just `:latest`).
2. **LocalStack** — pulls fine, but the container refuses to start at all:
   `License activation failed... No credentials were found... set
   LOCALSTACK_AUTH_TOKEN`. Every currently-listed tag (checked via Docker
   Hub's tag API, not just `:latest`) requires an account/token to run at
   all, even for the free community S3 service. This is the exact problem
   Cloudinary was rejected for — local dev depending on a live third-party
   account — so LocalStack was rejected for the identical reason.
3. **s3mock** (Adobe, Apache-2.0) — chosen. Pulls anonymously, starts with
   no license/account, and a plain `docker run` + PUT/GET against it
   confirmed real S3-API behavior (bucket creation, object PUT, object GET
   round-tripping exact bytes) before it was wired into docker-compose.yml.

## Decision 3: presigned POST, not PUT — and its real local limitation

`createPresignedUpload` (`infrastructure/storage/presign.ts`) uses
`@aws-sdk/s3-presigned-post`, not a presigned PUT URL. A PUT signature can
only authorize "this exact key may be written" — it has no way to also
constrain file size or content-type as part of the signature itself, which
would make those checks client-side-only and therefore bypassable by
anyone who skips the frontend and calls the presign endpoint directly. A
POST policy's `Conditions` (`content-length-range`, an exact-match
`Content-Type`) travel WITH the signed permission.

**Verified, and an honest limitation found in that verification**: a live
test uploaded a wrong-content-type file and a 6MB file (over the 5MB
limit) using otherwise-valid presigned-POST credentials — both succeeded
against s3mock (200), when real S3/R2 would reject them. This is a mock
limitation (s3mock implements core object CRUD but not full POST-policy
condition validation), not a bug in this code — confirmed by decoding the
actual signed policy document and finding the correct, standard
`content-length-range`/`Content-Type` conditions present and well-formed
(see `tests/uploads/presign.test.ts`'s policy-content test, which verifies
the document itself rather than depending on the mock to enforce it).
Stated plainly rather than either silently skipping this concern or
falsely claiming it was verified end-to-end.

## Decision 4: authorization is key-prefix scoping, not per-request ownership checks

Any authenticated user may call `POST /api/v1/uploads/presign` — there's
no separate "are you allowed to upload" check beyond being logged in. This
is safe because the object key is always `auctions/{sellerId}/{uuid}.ext`,
built server-side from the verified JWT's subject, never from client
input — nobody can be handed a signature for a key outside their own
prefix, so nobody can overwrite another seller's object. The endpoint
itself needs no dedicated rate limiter either: the already-global
`apiRateLimit` covers call frequency, and the real resource being
protected (bucket storage/bandwidth) is bounded per-object by the signed
policy's size limit, not by how often presign is called.

## Decision 5: bucket creation lives in application code, not infrastructure

After two infrastructure-level bucket-bootstrapping attempts (a MinIO `mc`
init container, then an AWS-CLI init container for LocalStack) were built
and then discarded along with their respective services, bucket creation
was moved into `s3Client.ts`'s `ensureBucketExists()` — called once, fire-
and-forget, at server boot. It's idempotent (catches
`BucketAlreadyOwnedByYou`/`BucketAlreadyExists` and treats them as
success) and never throws (object storage being unavailable at boot must
not block the app from serving unrelated traffic, same reasoning as
Redis/email — Section 51/12). This is also simply more portable: the exact
same code path is a no-op in production against a bucket that already
exists (created once, manually, via R2's dashboard — Section 83's
documented-manual-step pattern for cloud config), rather than needing a
different init mechanism per environment.

## Decision 6: the WebSocket payload precedent, reused

`modules/auctions/schema.ts`'s `images` field now requires every URL to
start with `env.S3_PUBLIC_URL_BASE` — a seller's only legitimate way to
get a URL into this array is the presigned-upload flow, which only ever
returns URLs under that exact base. Not primarily a security boundary
(nothing server-side ever fetches these URLs), but data integrity: Section
28 says never trust a client-controlled value further than necessary, and
without this check a client could submit any string at all.

## Addendum (2026-09-28): a real bug this design shipped with, and the fix

Reported by the developer: "the image is being uploaded but not visible via
frontend." Investigated rather than guessed at — traced to a self-inflicted
cause. `s3mock` was originally deployed with no volume at all (the write-up
above only ever discusses WHICH local S3-compatible server to use, never
whether its data should survive a restart). Earlier in this same session,
recreating the `s3mock` container to fix its healthcheck (`curl` → `wget`)
silently wiped every object that had been uploaded before that point, while
Postgres kept referencing the now-dead URLs — the browser's Chrome/Chromium
reported this as `net::ERR_BLOCKED_BY_ORB` (Opaque Response Blocking), which
looks like a CORS/rendering problem but was actually just how Chrome surfaces
an `<img>` request that received a 404/XML error body instead of image bytes.
Confirmed with a live auction (title "House") the developer had created
themselves: its image genuinely 404'd; a fresh upload made moments later
worked perfectly — proving the upload/serve code path itself was correct and
the gap was purely "this container's data doesn't survive being recreated."

**The fix wasn't just "add a volume"** — testing revealed s3mock ignores any
volume by default: it logs `"...root folder. Will retain files on exit:
false"` and writes to an ephemeral `/tmp` path regardless of what's mounted
where. The actual Spring property name
(`com.adobe.testing.s3mock.store.root`, environment-variable form
`COM_ADOBE_TESTING_S3MOCK_STORE_ROOT`) isn't documented anywhere obvious —
found by extracting readable strings directly from the image's own compiled
`StoreConfiguration.class` (`docker cp` + `grep -a`), not guessed. A second,
separate blocker: a fresh Docker named volume mounts owned by `root`, but
this image's default user is non-root (`uid 1000`), so every write failed
with an opaque `InternalError` until the container was run as `root`
(`user: "0:0"` — a pragmatic simplification acceptable for a local-only dev
container, not something that would be done for a production image). Every
step here — the property name, the ownership issue, the final combination —
was verified with a real `docker run`, a real upload, a real `docker
restart`, and a real GET, not assumed to work from documentation.

`docker-compose.yml`: `s3mock` now has a named volume (`s3mock_data`),
`user: "0:0"`, and both `COM_ADOBE_TESTING_S3MOCK_STORE_ROOT=/data` /
`COM_ADOBE_TESTING_S3MOCK_STORE_RETAINFILESONEXIT=true`. Verified live:
uploaded a real object, restarted the container (`docker restart`, the
lighter-weight case) AND fully recreated it (`docker rm` + `docker run`, the
actual scenario that caused the original bug) — the object survived both.
The developer's own pre-existing "House" test auction's image could not be
recovered (its bytes were already gone before the fix existed) and was left
as-is, not deleted, since it's the developer's own data.

This is also a scope note worth being explicit about: Redis (ADR-0005) was
deliberately left without a volume, and that was correct — rate-limit
counters are genuinely disposable. Object storage got the same "ephemeral is
fine" treatment by default here without that same reasoning actually being
applied to it, and it wasn't fine, because an uploaded image is real content,
not a counter. The right question per subsystem is "would losing this
silently surprise someone," not "does this project already have a volume
precedent to copy."

## Why

- **Every infrastructure choice here was tested before being committed
  to**, not assumed from documentation that turned out to be stale — MinIO
  and LocalStack both looked correct on paper and both failed in practice,
  caught by actually running `docker pull`/`docker run` rather than trusting
  Section 27/83's original (now outdated) naming of MinIO as "the" local
  choice.
- **The local-dev-independence principle was applied consistently**,
  including to a provider (LocalStack) that isn't normally thought of as
  "a third-party service" the way Cloudinary obviously is — the same test
  (does this require a live external account?) was applied evenhandedly.
- **Presigned POST's real advantage (server-enforced constraints) was
  verified for what it actually controls** (the generated policy document)
  rather than assumed to work end-to-end just because the mock accepted
  the upload — the mock accepting something insecure doesn't mean the
  policy document is wrong, but it also doesn't prove it's right, and only
  the second, narrower claim could actually be verified here.

## Tradeoffs

```text
s3mock as the local stand-in (not MinIO, not LocalStack):
+ No login, no account, no license — matches this project's local-dev
  independence principle better than any alternative tried
+ Real S3 API behavior for the operations this app actually uses
- Does NOT enforce presigned POST policy conditions — a local upload that
  violates size/type limits will incorrectly succeed where production
  (R2) would correctly reject it. A real, accepted gap in local fidelity,
  not silently hidden (see Consequences/Revisit).
- Less widely known than MinIO — a future contributor googling "docker
  compose minio setup" won't find this project's actual setup; the
  in-repo comments carry that context instead.

Presigned POST (not PUT):
+ Size/type constraints are cryptographically part of the granted
  permission, not a client-side-only check
- More complex client-side upload code (multipart form with the returned
  `fields`, not a single PUT with a body) — a real but small cost, isolated
  entirely to `lib/uploads.ts`
```

## Consequences

- New dependencies: `@aws-sdk/client-s3`, `@aws-sdk/s3-presigned-post`
  (backend only — the browser's native `FormData`/`fetch` are enough on
  the frontend, no client-side S3 SDK needed).
- `docker-compose.yml`: `s3mock` service (port 9090), no init container, a
  named volume + the two env vars that actually make it persist across a
  restart (see the Addendum above — a volume alone does nothing here).
- `services/api/src/config/env.ts`: `S3_*` vars, all defaulted to match
  `s3mock` locally (same "must boot without real config" pattern as
  `REDIS_URL`).
- `infrastructure/storage/s3Client.ts` (new): the singleton client +
  `ensureBucketExists`.
- `infrastructure/storage/presign.ts` (new): `createPresignedUpload`, the
  5MB/JPEG-PNG-WebP allow-list.
- `modules/uploads/` (new): `POST /api/v1/uploads/presign`, authenticated,
  no additional rate limiter.
- `modules/auctions/schema.ts`: `images` now validates the bucket-origin
  check described above.
- `apps/web/lib/uploads.ts` (new): `requestPresignedUpload`,
  `uploadToPresignedUrl`, client-side content-type pre-check (UX only, not
  authoritative).
- `apps/web/app/auctions/new/page.tsx`: file input, eager per-file upload
  on selection (not deferred to submit — the presigned-POST pattern is
  built for this), thumbnail previews with removal, `images` included in
  the create-auction payload.
- `apps/web/app/auctions/page.tsx` and `app/auctions/[id]/page.tsx`: render
  uploaded images (a first-image thumbnail on the browse list, a full
  strip on the detail page). Plain `<img>`, not `next/image` — the storage
  domain isn't fixed yet (local `s3mock` vs. an eventual R2 domain), so
  `next/image`'s required `remotePatterns` config can't be written until
  deployment; noted as a revisit condition, not silently worked around.
- Tests (`tests/uploads/presign.test.ts`, all passing): unauthenticated
  rejection, unsupported content-type rejection, response shape and
  bucket-origin scoping, two different sellers getting different key
  prefixes, and the signed-policy-document content check described above.
- **Verified live**, twice: (1) a scripted end-to-end flow — real register/
  login, real presign call, a REAL PNG uploaded via multipart POST directly
  to s3mock, GET returning byte-identical content, and creating an auction
  whose `images` array references that real URL, all via direct HTTP calls;
  (2) a real Playwright browser session — registered and logged in through
  the actual UI forms, selected a real image file through the file input,
  watched the thumbnail preview appear, submitted, and confirmed the
  resulting auction's image renders correctly on both the detail page and
  the public browse list.
- Full backend suite: 144/144. Both workspaces build/lint clean.

## Revisit Conditions

- Configure `next/image` with `remotePatterns` once the production R2
  domain (or custom domain) is known, replacing the plain `<img>` tags.
- If s3mock's lack of POST-policy enforcement ever becomes a real problem
  (e.g. it starts masking an actual bug in policy construction), consider
  a targeted integration test against a real, disposable R2 bucket in CI
  instead of trying to work around the mock's limitation locally.
- Re-check MinIO's and LocalStack's distribution terms periodically —
  both are popular, well-maintained projects, and either restriction could
  change again in either direction.
- Video upload (Section 1's stated goal, alongside images) — deliberately
  out of scope for this task (YAGNI: images alone exercise the full
  presigned-upload mechanism); add as its own task if/when it's needed,
  probably just widening the content-type allow-list and size limit.
