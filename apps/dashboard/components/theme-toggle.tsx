'use client';

import { useEffect, useState } from 'react';
import { THEME_KEY } from '@/lib/theme';

type Theme = 'dark' | 'light';

/** Header switch between the dark (default) and light theme; the choice is remembered in localStorage. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // private mode or blocked storage: the theme still changes for this visit
    }
    setTheme(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-card px-2.5 py-1 text-xs text-muted transition hover:border-line-strong hover:text-ink"
    >
      <span aria-hidden>{theme === 'dark' ? '☾' : '☀'}</span>
      {theme === 'dark' ? 'Dark' : 'Light'}
    </button>
  );
}
