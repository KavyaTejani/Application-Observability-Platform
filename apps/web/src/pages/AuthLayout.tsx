import { Activity, BellRing, Gauge, ScrollText } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ICON_STROKE } from '../components/ui';

const FEATURES = [
  { icon: Gauge, text: 'Request rate, error rate, and p95 latency per route' },
  { icon: ScrollText, text: 'Structured log search by severity, service, and request ID' },
  { icon: BellRing, text: 'Alert rules with deduplicated incidents and signed webhooks' },
];

/** Sign-in / register shell (docs/ui_theme.md §8.1; dark panel per §14.4). */
export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      <section className="hidden flex-col justify-between bw-r border-ink bg-accent p-10 text-accent-fg select-none lg:flex dark:bg-surface dark:text-fg">
        <Link to="/" className="flex items-center gap-2 font-display font-bold">
          <span className="flex size-8 items-center justify-center rounded-lg bw border-ink bg-pink text-[#111111] shadow-chip">
            <Activity className="size-4" strokeWidth={ICON_STROKE} aria-hidden="true" />
          </span>
          AOP{' '}
          <span className="font-sans font-normal text-accent-fg/70 dark:text-fg-muted">
            Application Observability
          </span>
        </Link>
        <div className="max-w-md">
          <h2 className="text-4xl leading-tight font-bold tracking-tight">
            Know when your Node.js services slow down — and why.
          </h2>
          <ul className="mt-8 space-y-3">
            {FEATURES.map(({ icon: Icon, text }) => (
              <li
                key={text}
                className="flex items-center gap-3 rounded-lg bw border-ink bg-surface p-3 text-sm font-medium text-fg shadow-chip dark:bg-subtle"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bw border-ink bg-accent-soft text-accent-text">
                  <Icon className="size-4" strokeWidth={ICON_STROKE} aria-hidden="true" />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="font-mono text-xs text-accent-fg/70 dark:text-fg-muted">
          Multi-tenant · metrics in Prometheus · logs in Loki
        </p>
      </section>

      <section className="flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <Link
            to="/"
            className="flex items-center justify-center gap-2 font-display font-bold text-fg lg:hidden"
          >
            <span className="flex size-7 items-center justify-center rounded-lg bw border-ink bg-pink text-[#111111] shadow-chip">
              <Activity className="size-4" strokeWidth={ICON_STROKE} aria-hidden="true" />
            </span>
            AOP
          </Link>
          <div className="mt-6 frame p-6 lg:mt-0">
            <h1 className="text-2xl font-bold tracking-tight text-fg">{title}</h1>
            <div className="mt-6">{children}</div>
          </div>
        </div>
      </section>
    </main>
  );
}
