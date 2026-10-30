import { Activity, BellRing, Gauge, ScrollText } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ICON_STROKE } from '../components/ui';

const FEATURES = [
  { icon: Gauge, text: 'Request rate, error rate, and p95 latency per route' },
  { icon: ScrollText, text: 'Structured log search by severity, service, and request ID' },
  { icon: BellRing, text: 'Alert rules with deduplicated incidents and signed webhooks' },
];

/** Sign-in / register shell (docs/ui_theme.md §8.1). */
export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      <section className="hidden flex-col justify-between bw-r border-ink bg-accent p-10 text-ink select-none lg:flex dark:border-transparent dark:bg-[#111114] dark:text-zinc-100">
        <Link to="/" className="flex items-center gap-2 font-display font-bold">
          <span className="flex size-8 items-center justify-center rounded-lg bw border-ink bg-pink shadow-chip dark:border-transparent dark:bg-accent">
            <Activity className="size-4" strokeWidth={ICON_STROKE} aria-hidden="true" />
          </span>
          AOP{' '}
          <span className="font-sans font-normal text-ink/70 dark:text-zinc-400">
            Application Observability
          </span>
        </Link>
        <div className="max-w-md">
          <h2 className="text-4xl leading-tight font-bold tracking-tight dark:text-white">
            Know when your Node.js services slow down — and why.
          </h2>
          <ul className="mt-8 space-y-3">
            {FEATURES.map(({ icon: Icon, text }) => (
              <li
                key={text}
                className="flex items-center gap-3 rounded-lg bw border-ink bg-surface p-3 text-sm font-medium text-ink shadow-chip dark:border-transparent dark:bg-white/5 dark:p-0 dark:font-normal dark:text-zinc-300 dark:shadow-none"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bw border-ink bg-accent-soft dark:border-transparent dark:bg-white/10 dark:text-indigo-300">
                  <Icon className="size-4" strokeWidth={ICON_STROKE} aria-hidden="true" />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="font-mono text-xs text-ink/70 dark:text-zinc-500">
          Multi-tenant · metrics in Prometheus · logs in Loki
        </p>
      </section>

      <section className="flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <Link
            to="/"
            className="flex items-center justify-center gap-2 font-display font-bold text-fg lg:hidden"
          >
            <span className="flex size-7 items-center justify-center rounded-lg bw border-ink bg-pink text-ink shadow-chip dark:border-transparent dark:bg-accent dark:text-accent-fg">
              <Activity className="size-4" strokeWidth={ICON_STROKE} aria-hidden="true" />
            </span>
            AOP
          </Link>
          <div className="mt-6 frame p-6 lg:mt-0 dark:border-0 dark:bg-transparent dark:p-0 dark:shadow-none">
            <h1 className="text-2xl font-bold tracking-tight text-fg">{title}</h1>
            <div className="mt-6">{children}</div>
          </div>
        </div>
      </section>
    </main>
  );
}
