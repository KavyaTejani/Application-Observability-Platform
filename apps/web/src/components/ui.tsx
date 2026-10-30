import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';
import { useId } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle, type LucideIcon } from 'lucide-react';

/*
 * Shared UI primitives (docs/ui_theme.md §7). Colours, border widths, radii, shadows, and press
 * movement all come from theme tokens in index.css, so the same markup renders the
 * neo-brutalist light theme and the calm dark theme.
 */

/** Lucide's default stroke looks thin next to 2 px borders (§9). */
export const ICON_STROKE = 2.25;

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'danger-outline' | 'ghost';

const BUTTON: Record<ButtonVariant, string> = {
  primary:
    'press bw border-ink bg-accent text-accent-fg shadow-control hover:bg-accent-hover disabled:opacity-50 dark:border-transparent',
  secondary:
    'press bw border-line-strong bg-surface text-fg shadow-control hover:bg-subtle disabled:text-fg-muted',
  danger:
    'press bw border-ink bg-danger-solid text-white shadow-control hover:brightness-110 disabled:opacity-50 dark:border-transparent',
  'danger-outline':
    'press bw border-line-strong bg-surface text-danger shadow-control hover:bg-danger-soft disabled:opacity-50',
  ghost: 'text-fg-secondary hover:bg-subtle hover:text-fg disabled:text-fg-muted',
};

export function Button({
  variant = 'primary',
  size = 'md',
  icon: Icon,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: LucideIcon;
}) {
  const sizing = size === 'sm' ? 'h-[30px] gap-1.5 px-2.5 text-xs' : 'h-9 gap-2 px-3.5 text-sm';
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex shrink-0 items-center justify-center rounded-lg font-display font-semibold whitespace-nowrap disabled:cursor-not-allowed ${sizing} ${BUTTON[variant]} ${className}`}
    >
      {Icon && (
        <Icon
          aria-hidden="true"
          strokeWidth={ICON_STROKE}
          className={size === 'sm' ? 'size-3.5' : 'size-4'}
        />
      )}
      {children}
    </button>
  );
}

const FIELD =
  'mt-1.5 block h-10 w-full rounded-lg bw bg-surface px-3 text-sm text-fg placeholder:text-fg-muted focus:shadow-focus focus:outline-none dark:focus:border-accent disabled:bg-subtle disabled:text-fg-muted';

function FieldMessage({ id, error, hint }: { id: string; error?: string; hint?: string }) {
  if (error)
    return (
      <p id={`${id}-error`} className="mt-1.5 text-xs font-medium text-danger">
        {error}
      </p>
    );
  if (hint)
    return (
      <p id={`${id}-hint`} className="mt-1.5 text-xs text-fg-muted">
        {hint}
      </p>
    );
  return null;
}

/** Labelled input with an associated, screen-reader-announced field error. */
export function TextField({
  label,
  error,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-fg">
        {label}
      </label>
      <input
        id={id}
        {...props}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`${FIELD} ${error ? 'border-danger' : 'border-line-strong'}`}
      />
      <FieldMessage id={id} error={error} hint={hint} />
    </div>
  );
}

/** Labelled native select, styled like TextField. */
export function SelectField({
  label,
  error,
  hint,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-fg">
        {label}
      </label>
      <select
        id={id}
        {...props}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`${FIELD} ${error ? 'border-danger' : 'border-line-strong'}`}
      >
        {children}
      </select>
      <FieldMessage id={id} error={error} hint={hint} />
    </div>
  );
}

/** Class string for bare inputs/selects that sit outside a labelled field (filters, toolbars). */
export const inputClass =
  'h-9 rounded-lg bw border-line-strong bg-surface px-2.5 text-sm text-fg focus:shadow-focus focus:outline-none dark:focus:border-accent';

const ALERT: Record<'error' | 'info' | 'success' | 'warning', { box: string; icon: LucideIcon }> = {
  error: { box: 'border-danger-line bg-danger-soft text-danger', icon: XCircle },
  warning: { box: 'border-warn-line bg-warn-soft text-warn', icon: AlertTriangle },
  info: { box: 'border-info-line bg-info-bg text-info-fg', icon: Info },
  success: { box: 'border-ok-line bg-ok-soft text-ok', icon: CheckCircle2 },
};

/** Feedback banner (§2.4): a message, not an object, so it has a border but no shadow. */
export function Alert({
  tone = 'error',
  children,
}: {
  tone?: 'error' | 'info' | 'success' | 'warning';
  children: ReactNode;
}) {
  const { box, icon: Icon } = ALERT[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex gap-2.5 rounded-lg bw p-3 text-sm ${box}`}
    >
      <Icon aria-hidden="true" strokeWidth={ICON_STROKE} className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 text-sm text-fg-muted">
      <Loader2 aria-hidden="true" className="size-4 animate-spin" />
      {label}
    </div>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  padded = true,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** false for edge-to-edge content such as tables. */
  padded?: boolean;
}) {
  return (
    <section className="frame">
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 bw-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            {title && <h2 className="text-base font-bold text-fg">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-fg-secondary">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

/** Page title row: heading, optional description, and actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-3xl font-bold tracking-tight text-fg">{title}</h1>
        {description && <p className="mt-1 text-sm text-fg-secondary">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Section label: small uppercase display type (sidebar groups, stat labels, table headers). */
export const sectionLabel =
  'font-display text-[11px] font-bold tracking-[0.08em] text-fg-muted uppercase';

/** Friendly empty state: what is missing and what to do next. */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <div className="flex size-12 items-center justify-center rounded-lg bw border-ink bg-accent-soft text-accent-text shadow-chip dark:border-transparent">
        <Icon aria-hidden="true" strokeWidth={ICON_STROKE} className="size-5" />
      </div>
      <p className="mt-3 font-display text-sm font-bold text-fg">{title}</p>
      {children && <div className="mt-1 max-w-sm text-sm text-fg-secondary">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** A single headline number (KPI tile). Data stays on the plain surface (§7.4). */
export function StatTile({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="frame p-4">
      <div className={`flex items-center gap-1.5 ${sectionLabel}`}>
        {Icon && <Icon aria-hidden="true" strokeWidth={ICON_STROKE} className="size-3.5" />}
        {label}
      </div>
      <div className="mt-1.5 font-display text-[28px] leading-8 font-bold tracking-tight text-fg tabular-nums">
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-fg-muted">{hint}</div>}
    </div>
  );
}

/** Small neutral or accent label. State badges with icons live in StatusBadge.tsx. */
export function Pill({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent';
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bw-thin px-2 py-0.5 text-xs font-medium ${
        tone === 'accent'
          ? 'border-ink bg-accent-soft text-accent-text dark:border-transparent'
          : 'border-ink bg-surface text-fg dark:border-transparent dark:bg-subtle dark:text-fg-secondary'
      }`}
    >
      {children}
    </span>
  );
}

/** Role shown as text, not colour alone (accessibility requirement). */
export function RoleBadge({ role }: { role: 'owner' | 'member' }) {
  return (
    <Pill tone={role === 'owner' ? 'accent' : 'neutral'}>
      {role === 'owner' ? 'Owner' : 'Member'}
    </Pill>
  );
}

/** Shared table classes (§7.6), so every table reads the same. */
export const table = {
  wrap: 'overflow-x-auto',
  table: 'w-full text-left text-sm',
  head: `bw-b border-line bg-subtle ${sectionLabel}`,
  th: 'px-4 py-2.5 whitespace-nowrap',
  row: 'border-b border-divider last:border-0 hover:bg-subtle/60',
  td: 'px-4 py-3',
};
