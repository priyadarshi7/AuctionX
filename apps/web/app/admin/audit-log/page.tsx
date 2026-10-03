'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { listAuditLogRequest } from '@/lib/admin';
import { useAuthStore } from '@/store/authStore';
import { Button } from '../../components/ui/Button';
import { PageHeader, PageMessage, Skeleton } from '../../components/ui/Page';
import { AuditList } from '../AuditList';

export default function AdminAuditLogPage() {
  const accessToken = useAuthStore((s) => s.accessToken)!;
  const query = useInfiniteQuery({
    queryKey: ['admin', 'audit-log'],
    queryFn: ({ pageParam }) => listAuditLogRequest(accessToken, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const entries = query.data?.pages.flatMap((p) => p.entries) ?? [];

  return (
    <>
      <PageHeader title="Audit log" subtitle="Every admin action, newest first. This record is permanent." />
      {query.isLoading && <Skeleton className="h-48" />}
      {query.isError && <PageMessage title="Couldn’t load the audit log" body="Try refreshing the page." />}
      {!query.isLoading && !query.isError && <AuditList entries={entries} />}
      {query.hasNextPage && (
        <div className="mt-5 flex justify-center">
          <Button variant="secondary" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </>
  );
}
