import Link from 'next/link';
import type { AuditEntry } from '@/lib/types/admin';

const ACTION_LABEL: Record<string, string> = {
  'user.status_changed': 'Changed user status',
  'user.role_changed': 'Changed user role',
  'auction.pause': 'Paused auction',
  'auction.resume': 'Resumed auction',
  'auction.cancel': 'Cancelled auction',
  'auction.approve': 'Approved listing',
  'auction.reject': 'Sent listing back to seller',
  'user.trusted_changed': 'Changed trusted-seller status',
};

function targetHref(entry: AuditEntry): string | null {
  if (entry.targetType === 'auction') return `/auctions/${entry.targetId}`;
  if (entry.targetType === 'user') return `/admin/users?search=${encodeURIComponent(entry.targetId)}`;
  return null;
}

// What changed, in a human sentence, from the metadata the server recorded
// ({from, to} for status/role changes, plus via=cli for out-of-API actions).
function describeChange(entry: AuditEntry): string {
  const { from, to, via } = entry.metadata as { from?: string; to?: string; via?: string };
  const change = from && to ? `${from} → ${to}` : '';
  return [change, via === 'cli' ? 'via CLI' : ''].filter(Boolean).join(' · ');
}

export function AuditList({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) {
    return <p className="rounded-xl border-2 border-dashed border-line/30 p-4 text-sm text-ink/70">Nothing recorded yet.</p>;
  }
  return (
    <ul className="overflow-hidden rounded-2xl border-2 border-line bg-white">
      {entries.map((entry) => {
        const href = targetHref(entry);
        const change = describeChange(entry);
        return (
          <li key={entry.id} className="border-b border-line/10 px-4 py-3 text-sm last:border-b-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-semibold">
                {ACTION_LABEL[entry.action] ?? entry.action}
                {change && <span className="ml-2 font-normal text-ink/70">{change}</span>}
              </p>
              <time className="text-ink/60" dateTime={entry.createdAt}>
                {new Date(entry.createdAt).toLocaleString()}
              </time>
            </div>
            <p className="mt-0.5 text-ink/70">
              {entry.targetType}{' '}
              {href ? (
                <Link href={href} className="underline underline-offset-4">
                  {entry.targetId.slice(0, 8)}
                </Link>
              ) : (
                entry.targetId.slice(0, 8)
              )}
              {' · by '}
              {entry.actorId ? entry.actorId.slice(0, 8) : 'CLI'}
            </p>
            {entry.reason && <p className="mt-1 text-ink/80">“{entry.reason}”</p>}
          </li>
        );
      })}
    </ul>
  );
}
