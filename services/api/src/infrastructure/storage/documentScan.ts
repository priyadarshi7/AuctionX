import { env } from '../../config/env';
import { scanWithClamav } from '../security/clamav';

// What happens to an uploaded seller document before it is registered
// (ADR-0043). Two layers, and the difference matters:
//
// 1. BASIC (always on, no external service): the file's real bytes must match
//    the type it claims, PDFs may not carry active content (scripts, launch
//    actions, embedded files), and the standard EICAR antivirus test string is
//    refused. This is a content-sanity filter, NOT antivirus: it cannot find
//    malware hidden inside a well-formed image or PDF.
// 2. CLAMAV (opt-in, DOCUMENT_SCAN=clamav): the bytes are also streamed to a
//    clamd daemon, and the document is refused if it reports a signature. It
//    FAILS CLOSED: if clamd is unreachable, registration fails and the seller
//    retries, rather than letting an unscanned file through.

export type ScanResult = { ok: true } | { ok: false; reason: string };

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

// PDF keywords that make a document do something instead of just display.
// A certificate or receipt has no legitimate use for any of them.
const ACTIVE_PDF_KEYWORDS = ['/JavaScript', '/JS', '/Launch', '/EmbeddedFile', '/RichMedia'];

function matchesDeclaredType(bytes: Buffer, contentType: string): boolean {
  switch (contentType) {
    case 'application/pdf':
      return bytes.subarray(0, 1024).includes('%PDF-');
    case 'image/jpeg':
      return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/png':
      return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/webp':
      return bytes.length > 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
    default:
      return false;
  }
}

export function basicScan(bytes: Buffer, contentType: string): ScanResult {
  if (!matchesDeclaredType(bytes, contentType)) {
    return { ok: false, reason: 'The file contents do not match its type' };
  }
  const text = bytes.toString('latin1');
  if (text.includes(EICAR)) {
    return { ok: false, reason: 'The file was flagged as malware' };
  }
  if (contentType === 'application/pdf') {
    const active = ACTIVE_PDF_KEYWORDS.find((keyword) => text.includes(keyword));
    if (active) {
      return { ok: false, reason: 'PDFs containing scripts or embedded files are not accepted' };
    }
  }
  return { ok: true };
}

export async function scanDocument(bytes: Buffer, contentType: string): Promise<ScanResult> {
  const basic = basicScan(bytes, contentType);
  if (!basic.ok) return basic;

  if (env.DOCUMENT_SCAN === 'clamav') {
    // Throws ClamavUnavailableError on any infrastructure failure: the caller
    // treats that as "try again later", never as "clean".
    const verdict = await scanWithClamav(bytes, env.CLAMAV_HOST, env.CLAMAV_PORT);
    if (!verdict.clean) {
      return { ok: false, reason: 'The file was flagged as malware' };
    }
  }
  return { ok: true };
}
