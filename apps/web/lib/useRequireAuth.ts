'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuthStore } from '@/store/authStore';

// The "send anonymous visitors to /login" effect was copy-pasted into four
// pages; this is the one place it lives now. `ready` is true only once the
// session is authenticated AND the user/token are present, so pages can
// render `PageLoading` until then and never flash protected content.
export function useRequireAuth() {
  const router = useRouter();
  const status = useAuthStore((state) => state.status);
  const user = useAuthStore((state) => state.user);
  const accessToken = useAuthStore((state) => state.accessToken);

  useEffect(() => {
    if (status === 'anonymous') {
      router.replace('/login');
    }
  }, [status, router]);

  if (status === 'authenticated' && user && accessToken) {
    return { ready: true as const, user, accessToken };
  }
  return { ready: false as const, user: null, accessToken: null };
}
