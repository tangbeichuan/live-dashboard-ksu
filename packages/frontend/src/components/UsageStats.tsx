"use client";

import { useEffect, useState } from "react";
import {
  fetchUsage,
  fetchUsageRange,
  type UsageRangeResponse,
  type UsageResponse,
  type UsageRecord,
} from "@/lib/api";

interface Props {
  selectedDate: string;
  deviceId?: string;
  dashboardId?: string;
}

const RANGES: { days: number; label: string }[] = [
  { days: 1, label: "今天" },
  { days: 7, label: "近 7 天" },
  { days: 30, label: "近 30 天" },
];

function fmt(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** 纯 SVG 趋势折线（用于 7 天 / 30 天视图） */
function TrendChart({ points, unit }: { points: { date: string; value: number }[]; unit: string }) {
  const W = 520;
  const H = 84;
  const pad = 8;
  const max = Math.max(...points.map((p) => p.value), 1);
  const step = points.length > 1 ? (W - pad * 2) / (points.length - 1) : 0;
  const coords = points.map((p, i) => {
    const x = pad + i * step;
    const y = H - pad - (p.value / max) * (H - pad * 2);
    return [x, y] as const;
  });
  const path = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${path} L${coords[coords.length - 1][0].toFixed(1)},${H - pad} L${coords[0][0].toFixed(1)},${H - pad} Z`;
  const short = (d: string) => d.slice(5);

  return (
    <div className="mb-3">
      <div className="flex justify-between text-[10px] mb-1" style={{ color: "var(--color-text-muted)" }}>
        <span>{short(points[0].date)}</span>
        <span>峰值 {fmt(max)} {unit}</span>
        <span>{short(points[points.length - 1].date)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 84 }} preserveAspectRatio="none">
        <path d={area} fill="var(--color-primary)" opacity="0.12" />
        <path d={path} fill="none" stroke="var(--color-primary)" strokeWidth="2" strokeLinejoin="round" />
        {coords.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={points.length > 14 ? 1.2 : 2.4} fill="var(--color-primary)" />
        ))}
      </svg>
    </div>
  );
}

export default function UsageStats({ selectedDate, deviceId, dashboardId }: Props) {
  const [days, setDays] = useState(1);
  const [day, setDay] = useState<UsageResponse | null>(null);
  const [agg, setAgg] = useState<UsageRangeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const opts = dashboardId ? { dashboardId } : undefined;
    setLoading(true);
    const req =
      days === 1
        ? fetchUsage(selectedDate, controller.signal, deviceId, opts)
        : fetchUsageRange(selectedDate, days, controller.signal, deviceId, opts);
    req
      .then((r) => {
        if (controller.signal.aborted) return;
        if (days === 1) { setDay(r as UsageResponse); setAgg(null); }
        else { setAgg(r as UsageRangeResponse); setDay(null); }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setDay(null); setAgg(null);
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [selectedDate, deviceId, dashboardId, days]);

  const records: UsageRecord[] = days === 1 ? day?.records ?? [] : agg?.top ?? [];
  if (!loading && records.length === 0 && !agg) return null;

  const max = Math.max(...records.map((r) => r.minutes), 1);
  const shown = expanded ? records.slice(0, 30) : records.slice(0, 8);
  const screenTotal = days === 1 ? day?.screen_minutes ?? null : agg?.screen_minutes ?? null;
  const unlockedTotal = days === 1 ? day?.unlocked_minutes ?? null : null;
  const appTotal = days === 1 ? day?.total_minutes ?? 0 : agg?.total_minutes ?? 0;
  const trendPoints = (agg?.daily ?? []).map((d) => ({
    date: d.date,
    value: Math.round(d.screen_minutes ?? d.total_minutes),
  }));

  return (
    <div className="card-decorated rounded-md p-4 mt-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h2 className="text-sm font-semibold">📊 应用使用时长</h2>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.days}
              type="button"
              onClick={() => { setDays(r.days); setExpanded(false); }}
              className={`pill-btn text-xs px-2 py-0.5 ${
                days === r.days ? "bg-[var(--color-primary)] text-white border-[var(--color-primary)]" : ""
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs mb-3" style={{ color: "var(--color-text-muted)" }}>
        {days === 1
          ? (screenTotal !== null
              ? `亮屏 ${fmt(screenTotal)}${unlockedTotal !== null ? ` · 解锁 ${fmt(unlockedTotal)}` : ""} · 应用合计 ${fmt(appTotal)}`
              : `应用合计 ${fmt(appTotal)}`)
          : (screenTotal !== null
              ? `${agg?.days} 天亮屏合计 ${fmt(screenTotal)} · 日均 ${fmt(screenTotal / (agg?.days || 1))} · 应用合计 ${fmt(appTotal)}`
              : `${agg?.days} 天应用合计 ${fmt(appTotal)}`)}
      </p>

      {days > 1 && trendPoints.length > 1 && (
        <TrendChart points={trendPoints} unit="亮屏" />
      )}

      <div className="flex flex-col gap-2">
        {shown.map((r, i) => (
          <div key={r.app_id} className="flex items-center gap-2">
            <span className="text-[10px] w-4 text-right" style={{ color: "var(--color-text-muted)" }}>{i + 1}</span>
            <span className="text-xs w-24 truncate" title={`${r.app_name} (${r.app_id})`}>{r.app_name}</span>
            <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: "rgba(0,0,0,0.06)" }}>
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.max(2, (r.minutes / max) * 100)}%`, background: "var(--color-primary)" }}
              />
            </div>
            <span className="text-xs w-16 text-right" style={{ color: "var(--color-text-muted)" }}>{fmt(r.minutes)}</span>
          </div>
        ))}
        {loading && <p className="text-xs text-center" style={{ color: "var(--color-text-muted)" }}>加载中…</p>}
      </div>

      <p className="text-[10px] mt-3 text-center" style={{ color: "var(--color-text-muted)" }}>
        口径与系统 UsageStats 一致（亮屏/解锁）；不含桌面、系统界面、输入法等排除项
      </p>

      {records.length > 8 && (
        <button
          type="button"
          className="pill-btn text-xs mt-3 mx-auto block"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "收起" : `展开全部 ${records.length} 个`}
        </button>
      )}
    </div>
  );
}
