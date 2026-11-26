// Shared by the server layout (inline no-flash script) and the client
// ThemeToggle, so it lives in a plain module: a constant exported from a
// 'use client' file isn't usable as a value on the server.
export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'auctionx-theme';
export const THEME_EVENT = 'auctionx-themechange';

// Runs before first paint so a saved "light" choice never flashes dark.
// Dark is the default: only an explicit saved "light" removes the class.
export const THEME_INIT_SCRIPT = `try{if(localStorage.getItem('${THEME_STORAGE_KEY}')==='light'){document.documentElement.classList.remove('dark')}}catch(e){}`;
