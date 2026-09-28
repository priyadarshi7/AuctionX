'use client';

import { useEffect, useState } from 'react';

// A client-only ticking clock, not a server push — there's no WebSocket
// yet (that's Phase 6), so "live" here just means recomputing against the
// current time every second. Good enough to show a real countdown; not a
// substitute for the server remaining authoritative about when an auction
// actually ends (Section 18 — the closing worker decides that, not this).
export function useTimeRemaining(endTime: string | null): string {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!endTime) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [endTime]);

  if (!endTime) return '—';

  const remainingMs = new Date(endTime).getTime() - now;
  if (remainingMs <= 0) return 'Ended';

  const totalSeconds = Math.floor(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
