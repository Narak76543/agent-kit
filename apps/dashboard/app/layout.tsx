import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AutoRefresh } from '@/components/auto-refresh';
import { Nav } from '@/components/nav';
import { NOW } from '@/lib/data';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agent Pipelines',
  description: 'Tossana agent pipelines across projects (read only)',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
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
                <span className="grid size-8 place-items-center rounded-lg bg-accent text-sm font-semibold text-white">
                  T
                </span>
                <span className="text-lg font-medium whitespace-nowrap">Agent Pipelines</span>
              </Link>
              <span className="text-right text-sm text-muted">
                Read-only preview
                <span className="hidden sm:inline">
                  {' '}
                  · sample data ·{' '}
                  {NOW.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC
                </span>
              </span>
            </div>
            <Nav />
          </div>
        </header>
        <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-8 sm:py-8">{children}</main>
      </body>
    </html>
  );
}
