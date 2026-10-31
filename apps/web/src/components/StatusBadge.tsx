import {
  AlertOctagon,
  Ban,
  CheckCircle2,
  CircleDot,
  Clock,
  PauseCircle,
  TriangleAlert,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { RuleState } from '../lib/alerts';
import { useNow } from '../lib/use-now';

/**
 * Reserved status colours (dataviz palette: good / warning / serious / critical; docs/ui_theme.md
 * §2.3). They are fixed across themes and always paired with an icon and a text label, so state is
 * never conveyed by colour alone. Text on "good" is ink: white on #0ca30c is only 3.35:1.
 */
const STATUS = {
  good: 'bg-[#0ca30c] text-[#111111]',
  warning: 'bg-[#fab219] text-[#0b0b0b]',
  serious: 'bg-[#ec835a] text-[#0b0b0b]',
  critical: 'bg-[#d03b3b] text-white',
  neutral: 'bg-surface text-fg',
} as const;

function Badge({
  tone,
  icon: Icon,
  label,
}: {
  tone: keyof typeof STATUS;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bw-thin border-ink px-2 py-0.5 text-xs font-semibold whitespace-nowrap select-none ${STATUS[tone]}`}
    >
      <Icon aria-hidden="true" strokeWidth={2.25} className="size-3.5" />
      {label}
    </span>
  );
}

const RULE: Record<RuleState, { tone: keyof typeof STATUS; icon: LucideIcon; label: string }> = {
  normal: { tone: 'good', icon: CheckCircle2, label: 'Normal' },
  pending: { tone: 'warning', icon: Clock, label: 'Pending' },
  firing: { tone: 'critical', icon: TriangleAlert, label: 'Firing' },
  error: { tone: 'serious', icon: AlertOctagon, label: 'Error' },
};

export function RuleStateBadge({ state, enabled }: { state: RuleState; enabled: boolean }) {
  if (!enabled) return <Badge tone="neutral" icon={PauseCircle} label="Disabled" />;
  return <Badge {...RULE[state]} />;
}

export function IncidentStatusBadge({ status }: { status: 'firing' | 'resolved' }) {
  return status === 'firing' ? (
    <Badge tone="critical" icon={TriangleAlert} label="Firing" />
  ) : (
    <Badge tone="good" icon={CheckCircle2} label="Resolved" />
  );
}

export function DeliveryStatusBadge({ status }: { status: 'success' | 'failed' | 'blocked' }) {
  if (status === 'success') return <Badge tone="good" icon={CheckCircle2} label="Delivered" />;
  if (status === 'blocked') return <Badge tone="serious" icon={Ban} label="Blocked" />;
  return <Badge tone="critical" icon={XCircle} label="Failed" />;
}

/** Telemetry freshness of a project: live, stale, or never received. */
export function FreshnessBadge({ lastTelemetryAt }: { lastTelemetryAt: string | null }) {
  const now = useNow();
  if (!lastTelemetryAt) return <Badge tone="neutral" icon={CircleDot} label="No data yet" />;
  const ageMs = now - Date.parse(lastTelemetryAt);
  return ageMs < 5 * 60_000 ? (
    <Badge tone="good" icon={CircleDot} label="Receiving" />
  ) : (
    <Badge tone="neutral" icon={CircleDot} label="Idle" />
  );
}
