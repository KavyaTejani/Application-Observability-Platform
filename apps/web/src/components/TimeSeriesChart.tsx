import { useId, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatClock } from '../lib/format';
import { useTheme, type ResolvedTheme } from '../lib/theme';

/**
 * Categorical slots 1–3 of the reference palette, with separately selected steps per mode, each
 * validated against this app's card surface (light #ffffff: adjacent CVD ΔE ≥ 9.2, normal-vision
 * ΔE ≥ 27.6; dark #1a1920: CVD ΔE ≥ 9.4, normal ΔE ≥ 26.5). Light slot 3 is below 3:1 against
 * white, so every chart offers a data-table view (the required relief), and identity is never
 * carried by colour alone.
 */
const THEME: Record<
  ResolvedTheme,
  {
    series: readonly string[];
    ink: { muted: string; grid: string; axis: string; secondary: string; surface: string };
    /** Tooltip frame: an edge-coloured border and hard shadow in both themes (§7.10, §14.5). */
    tooltip: { border: string; width: number; shadow: string };
  }
> = {
  light: {
    series: ['#2a78d6', '#eb6834', '#1baf7a'],
    ink: {
      muted: '#5b5b5b',
      grid: '#ece7dc',
      axis: '#c9c2b4',
      secondary: '#3a3a3a',
      surface: '#ffffff',
    },
    tooltip: { border: '#111111', width: 2, shadow: '2px 2px 0 0 #111111' },
  },
  dark: {
    series: ['#3987e5', '#d95926', '#199e70'],
    ink: {
      muted: '#a9a49b',
      grid: '#2c2a35',
      axis: '#4a4658',
      secondary: '#d6d1c6',
      surface: '#1a1920',
    },
    tooltip: { border: '#f2ede2', width: 2, shadow: '3px 3px 0 0 #8a63e6' },
  },
};

/** Series colours for the current theme, for legends drawn outside the chart. */
export function useSeriesColors(): readonly string[] {
  return THEME[useTheme().resolved].series;
}

export interface ChartSeries {
  name: string;
  points: Array<[number, number | null]>;
}

interface Props {
  title: string;
  /** Unit shown in the title, axis, and tooltip, e.g. "req/s", "%", "ms". */
  unit: string;
  series: ChartSeries[];
  formatValue: (value: number) => string;
  /** Domain of the x axis (epoch ms), so empty edges stay visible. */
  start: number;
  end: number;
  rangeLabel: string;
}

type Row = { t: number } & Record<string, number | null>;

export function TimeSeriesChart({
  title,
  unit,
  series,
  formatValue,
  start,
  end,
  rangeLabel,
}: Props) {
  const { series: SERIES_COLORS, ink: INK, tooltip: TIP } = THEME[useTheme().resolved];
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();
  const rows = useMemo<Row[]>(() => {
    const byTime = new Map<number, Row>();
    series.forEach((s, i) => {
      for (const [t, v] of s.points) {
        const row = byTime.get(t) ?? ({ t } as Row);
        row[`s${i}`] = v;
        byTime.set(t, row);
      }
    });
    return [...byTime.values()].sort((a, b) => a.t - b.t);
  }, [series]);
  const longRange = end - start > 6 * 3_600_000;

  return (
    <figure className="frame p-4">
      <figcaption className="mb-3 flex items-baseline justify-between gap-2">
        <span className="font-display text-sm font-bold text-fg">
          {title} <span className="font-normal text-fg-muted">({unit})</span>
        </span>
        <span className="text-xs text-fg-muted">{rangeLabel}</span>
      </figcaption>

      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={INK.grid} strokeWidth={1} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={[start, end]}
              tickFormatter={(t: number) => formatClock(t)}
              tick={{ fill: INK.muted, fontSize: 11 }}
              stroke={INK.axis}
              tickLine={false}
              minTickGap={longRange ? 48 : 32}
            />
            <YAxis
              tickFormatter={(v: number) => formatValue(v)}
              tick={{ fill: INK.muted, fontSize: 11 }}
              stroke={INK.axis}
              tickLine={false}
              axisLine={false}
              width={56}
              allowDecimals
            />
            <Tooltip
              isAnimationActive={false}
              cursor={{ stroke: INK.axis, strokeWidth: 1 }}
              labelFormatter={(t) => formatClock(Number(t), true)}
              formatter={(value, name) => [
                typeof value === 'number' ? `${formatValue(value)} ${unit}` : 'no data',
                name,
              ]}
              contentStyle={{
                borderRadius: 6,
                border: `${TIP.width}px solid ${TIP.border}`,
                boxShadow: TIP.shadow,
                background: INK.surface,
                fontSize: 12,
              }}
              labelStyle={{ color: INK.secondary }}
              itemStyle={{ color: INK.secondary }}
            />
            {series.length >= 2 && (
              <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, color: INK.secondary }} />
            )}
            {series.map((s, i) => (
              <Line
                key={s.name}
                name={s.name}
                dataKey={`s${i}`}
                type="monotone"
                stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: INK.surface }}
                // Gaps mean "no data" and must not be bridged or drawn as zero (MET-006).
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <button
        type="button"
        className="mt-2 text-xs font-medium text-accent-text hover:underline"
        aria-expanded={showTable}
        aria-controls={tableId}
        onClick={() => setShowTable((v) => !v)}
      >
        {showTable ? 'Hide data table' : 'Show data table'}
      </button>
      {showTable && (
        <div id={tableId} className="mt-2 max-h-56 overflow-auto">
          <table className="w-full text-left text-xs tabular-nums">
            <thead className="sticky top-0 bg-surface text-fg-muted">
              <tr>
                <th className="py-1 pr-3 font-medium">Time</th>
                {series.map((s) => (
                  <th key={s.name} className="py-1 pr-3 font-medium">
                    {s.name} ({unit})
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.t} className="border-t border-divider">
                  <td className="py-1 pr-3 text-fg-secondary">{formatClock(row.t, true)}</td>
                  {series.map((s, i) => {
                    const v = row[`s${i}`];
                    return (
                      <td key={s.name} className="py-1 pr-3">
                        {typeof v === 'number' ? formatValue(v) : '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}
