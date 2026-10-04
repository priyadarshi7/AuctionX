# ADR-0043: Scanning uploaded documents, and cleaning up files nothing points at

## Context

ADR-0041 let sellers upload paperwork to a private bucket and listed two gaps:
files could be left behind after an account was deleted, and uploads were not
scanned. Admins open these files, so an upload is untrusted input that a human
will click.

## Problem

1. Deleting an account cascades the database rows but leaves the files.
   Other things also strand files: an upload that is presigned but never
   registered, a refused file, a failed delete.
2. A seller could register anything under a PDF name, and an admin would open
   it. Real antivirus (ClamAV) needs about 1GB of RAM; Render's free tier has
   512MB, and there is no free managed scanning service that keeps private
   documents private (VirusTotal publishes what it is sent).

## Options Considered

- **VirusTotal API.** Rejected: uploading a private certificate to a service
  that shares samples defeats the private bucket.
- **ClamAV only.** Right tool, but cannot run in the free production
  environment, so "scanning" would be off exactly where it matters.
- **No scanning, rely on signed URLs and the viewer.** Rejected: leaves the
  gap open.
- **Layered: always-on built-in checks, plus optional ClamAV that fails
  closed.** Chosen.
- **Cleanup only on account deletion** vs **also a sweeper.** Deletion-time
  cleanup is immediate but only one of several ways files get stranded; a
  sweeper covers all of them.

## Decision

- **Scanning happens at registration, on the real object** (read back from the
  bucket after the size check, never the client's claim), before the file can
  be shown to anyone.
  - **Basic (always on):** the bytes must match the declared type (PDF header,
    JPEG/PNG/WebP magic bytes), PDFs may not contain `/JavaScript`, `/JS`,
    `/Launch`, `/EmbeddedFile` or `/RichMedia`, and the EICAR test string is
    refused. A refused file is deleted and the seller gets a 400.
  - **ClamAV (opt-in, `DOCUMENT_SCAN=clamav`):** the bytes are also streamed to
    clamd over its INSTREAM protocol (a small raw-socket client, no new
    dependency). It **fails closed**: if clamd is unreachable the registration
    returns 503 `SCAN_UNAVAILABLE` and the seller retries; nothing unscanned is
    accepted and the uploaded file is kept for the retry.
  - A `clamav` service exists in docker-compose behind the `scan` profile.
- **Account deletion** collects the seller's document keys before the cascade,
  and deletes the objects after the database delete commits.
- **A sweeper** (every 6 hours, unref'd interval) lists `documents/` in the
  bucket and deletes objects older than 24 hours that have no
  `auction_documents` row. The age floor protects an upload that is legitimately
  waiting to be registered. It is idempotent and safe on several instances.

## Why

The built-in checks cost nothing and stop the cheap attacks (a renamed
executable, a scripted PDF). ClamAV adds real signature detection where it can
run. Failing closed means a scanner outage degrades to "try again", never to
"unscanned file accepted". The sweeper is the single mechanism that covers
every way a file can be stranded, so deletion-time cleanup can stay best effort.

## Tradeoffs

- **Basic scanning is not antivirus.** It cannot find malware hidden in a
  well-formed image or PDF. In production today (`DOCUMENT_SCAN=basic`, no
  clamd) that is the actual protection, and it should be described as such. The
  further mitigations that already exist: files are never public, are served
  inline only through 5-minute signed URLs, and the allowed types are limited.
- Rejecting every PDF with `/JS` or `/EmbeddedFile` will refuse a rare
  legitimate form PDF. Acceptable for certificates and receipts; revisit if
  sellers complain.
- Registration now downloads the file (up to 10MB) from the bucket: one more
  round trip on a rare, non-latency-critical path.
- The sweeper's `DeleteObjects` batch call is covered by tests against the
  local S3 emulator; against Supabase Storage only `ListObjectsV2` was
  verified live. A failing batch is logged and retried on the next sweep.
- If an account deletion's object cleanup fails, files linger until the next
  sweep (up to about 30 hours).

## Consequences

Sellers cannot register a disguised or scripted file, a deleted account's
paperwork does not accumulate, and the bucket self-heals.

## Revisit Conditions

- Run clamd (a paid or self-hosted host with at least 1GB) and set
  `DOCUMENT_SCAN=clamav`; the code path is tested against a protocol-level fake
  but not yet against a live clamd.
- Scan asynchronously with a PENDING/CLEAN/INFECTED state if scanning ever gets
  slow enough to hurt the upload flow.
- Re-scan on a signature database update for files that are still in the bucket.
