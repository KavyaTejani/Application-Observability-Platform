import type { RuleState } from '../lib/alerts';

/**
 * Reserved status colours (dataviz palette: good / warning / serious / critical), always paired
 * with an icon and a text label, so state is never conveyed by colour alone.
 */
const STATUS = {
  good: 'bg-[#0ca30c] text-white',
  warning: 'bg-[#fab219] text-[#0b0b0b]',
  serious: 'bg-[#ec835a] text-[#0b0b0b]',
  critical: 'bg-[#d03b3b] text-white',
  neutral: 'bg-slate-200 text-slate-800',
} as const;

function Badge({ tone, icon, label }: { tone: keyof typeof STATUS; icon: string; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS[tone]}`}
    >
      <span aria-hidden="true">{icon}</span>
      {label}
    </span>
  );
}

const RULE: Record<RuleState, { tone: keyof typeof STATUS; icon: string; label: string }> = {
  normal: { tone: 'good', icon: '✓', label: 'Normal' },
  pending: { tone: 'warning', icon: '◔', label: 'Pending' },
  firing: { tone: 'critical', icon: '▲', label: 'Firing' },
  error: { tone: 'serious', icon: '!', label: 'Error' },
};

export function RuleStateBadge({ state, enabled }: { state: RuleState; enabled: boolean }) {
  if (!enabled) return <Badge tone="neutral" icon="⏸" label="Disabled" />;
  return <Badge {...RULE[state]} />;
}

export function IncidentStatusBadge({ status }: { status: 'firing' | 'resolved' }) {
  return status === 'firing' ? (
    <Badge tone="critical" icon="▲" label="Firing" />
  ) : (
    <Badge tone="good" icon="✓" label="Resolved" />
  );
}

export function DeliveryStatusBadge({ status }: { status: 'success' | 'failed' | 'blocked' }) {
  if (status === 'success') return <Badge tone="good" icon="✓" label="Delivered" />;
  if (status === 'blocked') return <Badge tone="serious" icon="⛔" label="Blocked" />;
  return <Badge tone="critical" icon="✕" label="Failed" />;
}
