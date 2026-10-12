'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Board' },
  { href: '/agents', label: 'Agents' },
  { href: '/skills', label: 'Skills' },
  { href: '/mcp', label: 'MCP catalog' },
  { href: '/projects', label: 'Projects' },
];

export function Nav() {
  const pathname = usePathname();
  const active = (href: string) =>
    href === '/' ? pathname === '/' || pathname.startsWith('/tasks') : pathname.startsWith(href);
  return (
    <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label="Main">
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          aria-current={active(l.href) ? 'page' : undefined}
          className={`border-b-2 px-3 py-3 text-sm whitespace-nowrap transition ${
            active(l.href) ? 'border-accent font-medium text-accent' : 'border-transparent text-muted hover:text-ink'
          }`}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
