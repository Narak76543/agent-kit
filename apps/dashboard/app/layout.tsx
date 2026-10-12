import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AutoRefresh } from '@/components/auto-refresh';
import { Nav } from '@/components/nav';
import { ThemeToggle } from '@/components/theme-toggle';
import { THEME_KEY } from '@/lib/theme';
import { NOW } from '@/lib/data';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agent Pipelines',
  description: 'Tossana agent pipelines across projects (read only)',
};

/** Applies the remembered theme before the first paint (no flash). Dark is the default. */
const THEME_SCRIPT = `try{var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Google+Sans+Flex:wght@400;500;600&display=swap"
        />
      </head>
      <body className="min-h-screen font-sans antialiased">
        <AutoRefresh seconds={60} />
        <header className="border-b border-line bg-card">
          <div className="mx-auto max-w-[1440px] px-4 sm:px-8">
            <div className="flex items-center justify-between gap-4 pt-4 pb-1">
              <Link href="/" className="flex items-center gap-2.5">
                <span className="grid size-8 place-items-center rounded-sm bg-accent text-sm font-semibold text-on-accent">
                  T
                </span>
                <span className="text-lg font-medium whitespace-nowrap">Agent Pipelines</span>
              </Link>
              <div className="flex items-center gap-3 text-right text-sm text-muted">
                <span className="hidden sm:inline">
                  Read-only preview · sample data ·{' '}
                  {NOW.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC
                </span>
                <ThemeToggle />
              </div>
            </div>
            <Nav />
          </div>
        </header>
        <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-8 sm:py-8">{children}</main>
      </body>
    </html>
  );
}
