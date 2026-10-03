'use client';

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { listUsersRequest, setTrustedSellerRequest, setUserStatusRequest } from '@/lib/admin';
import { ApiError } from '@/lib/apiClient';
import type { AdminUser, UserRole, UserStatus } from '@/lib/types/admin';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { useAuthStore } from '@/store/authStore';
import { Button } from '../../components/ui/Button';
import { inputClass } from '../../components/ui/Field';
import { PageHeader, PageMessage, Skeleton } from '../../components/ui/Page';
import { ReasonForm } from '../ReasonForm';

const STATUS_STYLE: Record<UserStatus, string> = {
  ACTIVE: 'bg-green',
  SUSPENDED: 'bg-yellow',
  BANNED: 'bg-pink',
};

type Pending = { userId: string; status: UserStatus };

function UserRow({ user, selfId, accessToken }: { user: AdminUser; selfId: string; accessToken: string }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Pending | null>(null);

  const change = useMutation({
    mutationFn: ({ status, reason }: { status: UserStatus; reason?: string }) =>
      setUserStatusRequest(accessToken, user.id, status, reason),
    onSuccess: () => {
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
  const error = change.error instanceof ApiError ? change.error.message : change.error ? 'Something went wrong.' : null;

  // Trusted sellers skip the review queue for low-risk categories (ADR-0041).
  const trust = useMutation({
    mutationFn: (trusted: boolean) => setTrustedSellerRequest(accessToken, user.id, trusted),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin'] }),
  });
  const trustError = trust.error instanceof ApiError ? trust.error.message : trust.error ? 'Something went wrong.' : null;

  // The server refuses both of these; hiding the buttons just avoids
  // offering an action that can only fail.
  const protectedAccount = user.role === 'ADMIN' || user.id === selfId;

  return (
    <li className="border-b border-line/10 px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-display font-bold">
            {user.name}
            {user.role === 'ADMIN' && (
              <span className="ml-2 rounded-full border-2 border-line bg-cyan px-2 text-[11px] font-bold">Admin</span>
            )}
            {user.trustedSeller && (
              <span className="ml-2 rounded-full border-2 border-line bg-green px-2 text-[11px] font-bold">
                Trusted seller
              </span>
            )}
            {user.id === selfId && <span className="ml-2 text-xs font-normal text-ink/60">(you)</span>}
          </p>
          <p className="truncate text-sm text-ink/70">
            {user.email} · joined {new Date(user.createdAt).toLocaleDateString()}
            {!user.emailVerifiedAt && ' · email unverified'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full border-2 border-line px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLE[user.status]}`}
          >
            {user.status}
          </span>
          {user.role !== 'ADMIN' && (
            <Button
              size="sm"
              variant="ghost"
              disabled={trust.isPending}
              onClick={() => trust.mutate(!user.trustedSeller)}
              title="Trusted sellers skip review for everyday categories. Watches, jewelry, art and coins are always reviewed."
            >
              {user.trustedSeller ? 'Remove trust' : 'Mark trusted'}
            </Button>
          )}
          {!protectedAccount && (
            <>
              {user.status === 'ACTIVE' && (
                <>
                  <Button size="sm" variant="secondary" onClick={() => setPending({ userId: user.id, status: 'SUSPENDED' })}>
                    Suspend
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setPending({ userId: user.id, status: 'BANNED' })}>
                    Ban
                  </Button>
                </>
              )}
              {user.status === 'SUSPENDED' && (
                <Button size="sm" variant="danger" onClick={() => setPending({ userId: user.id, status: 'BANNED' })}>
                  Ban
                </Button>
              )}
              {user.status !== 'ACTIVE' && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={change.isPending}
                  onClick={() => change.mutate({ status: 'ACTIVE' })}
                >
                  Reinstate
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {pending && (
        <ReasonForm
          prompt={`Why are you ${pending.status === 'BANNED' ? 'banning' : 'suspending'} ${user.name}?`}
          confirmLabel={pending.status === 'BANNED' ? 'Ban user' : 'Suspend user'}
          pending={change.isPending}
          error={error}
          onConfirm={(reason) => change.mutate({ status: pending.status, reason })}
          onCancel={() => {
            setPending(null);
            change.reset();
          }}
        />
      )}
      {!pending && (error ?? trustError) && <p className="mt-2 text-sm font-medium">{error ?? trustError}</p>}
    </li>
  );
}

function UsersList() {
  const accessToken = useAuthStore((s) => s.accessToken)!;
  const selfId = useAuthStore((s) => s.user?.id) ?? '';
  const initialSearch = useSearchParams().get('search') ?? '';

  const [search, setSearch] = useState(initialSearch);
  const [role, setRole] = useState<UserRole | ''>('');
  const [status, setStatus] = useState<UserStatus | ''>('');
  const debouncedSearch = useDebouncedValue(search.trim());

  const filters = {
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
    ...(role ? { role } : {}),
    ...(status ? { status } : {}),
  };
  const query = useInfiniteQuery({
    queryKey: ['admin', 'users', filters],
    queryFn: ({ pageParam }) => listUsersRequest(accessToken, filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const users = query.data?.pages.flatMap((p) => p.users) ?? [];

  return (
    <>
      <PageHeader title="Users" subtitle="Search accounts, and suspend, ban or reinstate them." />

      <div className="mb-5 grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <input
          type="search"
          aria-label="Search users by name, email or id"
          placeholder="Search by name or email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={inputClass(false)}
        />
        <select
          aria-label="Filter by role"
          value={role}
          onChange={(e) => setRole(e.target.value as UserRole | '')}
          className={inputClass(false)}
        >
          <option value="">All roles</option>
          <option value="USER">Users</option>
          <option value="ADMIN">Admins</option>
        </select>
        <select
          aria-label="Filter by status"
          value={status}
          onChange={(e) => setStatus(e.target.value as UserStatus | '')}
          className={inputClass(false)}
        >
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="SUSPENDED">Suspended</option>
          <option value="BANNED">Banned</option>
        </select>
      </div>

      {query.isLoading && (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      )}
      {query.isError && <PageMessage title="Couldn’t load users" body="Try refreshing the page." />}
      {!query.isLoading && !query.isError && users.length === 0 && (
        <PageMessage title="No users match" body="Try a different search or filter." />
      )}
      {users.length > 0 && (
        <ul className="overflow-hidden rounded-2xl border-2 border-line bg-white">
          {users.map((user) => (
            <UserRow key={user.id} user={user} selfId={selfId} accessToken={accessToken} />
          ))}
        </ul>
      )}
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

// useSearchParams needs a Suspense boundary for static rendering.
export default function AdminUsersPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64" />}>
      <UsersList />
    </Suspense>
  );
}
