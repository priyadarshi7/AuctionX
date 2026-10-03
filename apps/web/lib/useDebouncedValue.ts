'use client';

import { useEffect, useState } from 'react';

// For search boxes: the query key only changes once typing pauses, so each
// keystroke doesn't fire a request.
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
