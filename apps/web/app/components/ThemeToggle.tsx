'use client';

import { IconMoon, IconSun } from '@tabler/icons-react';
import { useSyncExternalStore } from 'react';
import { THEME_EVENT, THEME_STORAGE_KEY, type Theme } from '@/lib/theme';
import { Button } from '@/components/wensity/button';

// The `.dark` class on <html> is the single source of truth: the inline
// script sets it before paint and this store only reads it, so there is no
// hydration mismatch (the server snapshot is the default, dark).
function subscribe(callback: () => void): () => void {
  window.addEventListener(THEME_EVENT, callback);
  return () => window.removeEventListener(THEME_EVENT, callback);
}

const getSnapshot = (): Theme => (document.documentElement.classList.contains('dark') ? 'dark' : 'light');
const getServerSnapshot = (): Theme => 'dark';

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const next: Theme = theme === 'dark' ? 'light' : 'dark';

  const toggle = () => {
    document.documentElement.classList.toggle('dark', next === 'dark');
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage can be blocked (private mode); the choice then only lasts
      // for this page view.
    }
    window.dispatchEvent(new Event(THEME_EVENT));
  };

  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label={`Switch to ${next} mode`}>
      {theme === 'dark' ? <IconSun className="size-4.5" stroke={1.6} /> : <IconMoon className="size-4.5" stroke={1.6} />}
    </Button>
  );
}
