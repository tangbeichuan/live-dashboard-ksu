import { upsertUsage, getUsageByDate, upsertScreenTime, getScreenTime, getUsageDaily, getUsageTopInRange, getScreenTimeRange } from "../db";
import { authenticateToken, isConfiguredDeviceId } from "../middleware/auth";
import { resolveAppMeta } from "../services/app-mapper";

const MAX_RECORDS = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 服务端排除列表：这些 app_id 不在统计里显示（例如桌面/系统界面/输入法）。
// 手机端也有自己的 USAGE_EXCLUDE（根本不上报），这里是"显示层"排除，改完无需动手机。
const HIDE_APPS = new Set(
  (process.env.USAGE_HIDE_APPS || "")
    .split(",").map((x) => x.trim()).filter(Boolean)
);
function visible<T extends { app_id: string }>(rows: T[]): T[] {
  return HIDE_APPS.size === 0 ? rows : rows.filter((r) => !HIDE_APPS.has(r.app_id));
}

export async function handleUsagePost(req: Request): Promise<Response> {
  const device = authenticateToken(req.headers.get("authorization"));
  if (!device) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

  const date = typeof body.date === "string" && DATE_RE.test(body.date) ? body.date : null;
  if (!date) return Response.json({ error: "date required (YYYY-MM-DD)" }, { status: 400 });
  if (!Array.isArray(body.records) || body.records.length === 0) {
    return Response.json({ error: "records array required" }, { status: 400 });
  }
  if (body.records.length > MAX_RECORDS) {
    return Response.json({ error: `too many records (max ${MAX_RECORDS})` }, { status: 400 });
  }

  const screenMinutes = typeof body.screen_minutes === "number" && Number.isFinite(body.screen_minutes)
    ? Math.max(0, Math.min(1440, body.screen_minutes)) : null;
  const unlockedMinutes = typeof body.unlocked_minutes === "number" && Number.isFinite(body.unlocked_minutes)
    ? Math.max(0, Math.min(1440, body.unlocked_minutes)) : null;

  const now = new Date().toISOString();
  if (screenMinutes !== null || unlockedMinutes !== null) {
    try { upsertScreenTime.run(device.device_id, date, screenMinutes, unlockedMinutes, now); } catch (e: any) { console.error("[usage] screen db:", e.message); }
  }
  let saved = 0;
  for (const r of body.records) {
    const appId = typeof r.app_id === "string" ? r.app_id.trim().slice(0, 200) : "";
    const minutes = typeof r.minutes === "number" && Number.isFinite(r.minutes) ? r.minutes : null;
    if (!appId || minutes === null || minutes < 0 || minutes > 1440) continue;
    const { appName } = resolveAppMeta(appId, device.platform, undefined);
    try {
      upsertUsage.run(device.device_id, date, appId, appName, Math.round(minutes * 10) / 10, now);
      saved++;
    } catch (e: any) { console.error("[usage] db:", e.message); }
  }
  return Response.json({ ok: true, saved, screen: screenMinutes, unlocked: unlockedMinutes });
}

export function handleUsageQuery(url: URL): Response {
  const date = url.searchParams.get("date");
  if (!date || !DATE_RE.test(date)) return Response.json({ error: "date required (YYYY-MM-DD)" }, { status: 400 });
  const deviceId = url.searchParams.get("device_id") || "";
  if (deviceId && !isConfiguredDeviceId(deviceId)) return Response.json({ date, records: [], total_minutes: 0 });
  const st = deviceId ? (getScreenTime.get(deviceId, date) as any) : null;
  const rows = visible(getUsageByDate.all(date, deviceId, deviceId) as any[]);
  const total = rows.reduce((a, r) => a + (r.minutes || 0), 0);
  return Response.json({
    date,
    device_id: deviceId || "all",
    total_minutes: Math.round(total * 10) / 10,
    screen_minutes: st?.screen_minutes ?? null,
    unlocked_minutes: st?.unlocked_minutes ?? null,
    records: rows,
  });
}

// 区间统计（周/月视图 + 趋势）
export function handleUsageRange(url: URL): Response {
  const endRaw = url.searchParams.get("end") || new Date().toISOString().slice(0, 10);
  if (!DATE_RE.test(endRaw)) return Response.json({ error: "end required (YYYY-MM-DD)" }, { status: 400 });
  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "7", 10) || 7, 1), 90);
  const deviceId = url.searchParams.get("device_id") || "";
  if (deviceId && !isConfiguredDeviceId(deviceId)) {
    return Response.json({ end: endRaw, days, start: endRaw, daily: [], top: [], total_minutes: 0 });
  }
  const endMs = Date.parse(endRaw + "T00:00:00Z");
  const startRaw = new Date(endMs - (days - 1) * 86400000).toISOString().slice(0, 10);

  const dailyRows = getUsageDaily.all(startRaw, endRaw, deviceId, deviceId) as any[];
  const screenRows = getScreenTimeRange.all(startRaw, endRaw, deviceId, deviceId) as any[];
  const topRows = visible(getUsageTopInRange.all(startRaw, endRaw, deviceId, deviceId) as any[]);

  const screenByDate = new Map<string, any>();
  for (const r of screenRows) screenByDate.set(r.date, r);

  // 补齐没有数据的日期（趋势图需要连续轴）
  const daily: any[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(endMs - (days - 1 - i) * 86400000).toISOString().slice(0, 10);
    const u = dailyRows.find((r) => r.date === d);
    const st = screenByDate.get(d);
    daily.push({
      date: d,
      total_minutes: u ? Math.round(u.total_minutes * 10) / 10 : 0,
      screen_minutes: st?.screen_minutes ?? null,
      unlocked_minutes: st?.unlocked_minutes ?? null,
    });
  }

  const total = topRows.reduce((a, r) => a + (r.minutes || 0), 0);
  const screenSum = daily.reduce((a, d) => a + (d.screen_minutes || 0), 0);
  return Response.json({
    end: endRaw,
    start: startRaw,
    days,
    device_id: deviceId || "all",
    total_minutes: Math.round(total * 10) / 10,
    screen_minutes: screenSum > 0 ? Math.round(screenSum * 10) / 10 : null,
    daily,
    top: topRows,
  });
}
