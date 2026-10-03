/**
 * 事件 watcher：定期对比 device_states，把"变化"写成 events 行。
 * 只有环境变量 WATCH_DEVICES 里列出的设备会被监听（其他设备不产生事件）。
 * 这些事件是私有的，只能通过带 Bearer token 的 GET /api/events 读取。
 */
import { insertEvent, listDeviceStates, getLastEventByKind } from "../db";

const WATCH_DEVICES = (process.env.WATCH_DEVICES || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const BATTERY_LOW = parseInt(process.env.WATCH_BATTERY_LOW || "20", 10);
const COOLDOWN_MS = parseInt(process.env.WATCH_COOLDOWN || "60", 10) * 1000;
// 上线/离线抖动抑制：同一设备的状态变化在窗口内只"通知"一次（事件仍全部入库）
const STATE_COOLDOWN_MS = parseInt(process.env.WATCH_STATE_COOLDOWN || "600", 10) * 1000;
// 冷却窗口：0 = 不抑制
function cooldownFor(kind: string): number {
  if (kind === "online" || kind === "offline") return STATE_COOLDOWN_MS;
  if (kind === "app") return COOLDOWN_MS;
  return 0;
}
const INTERVAL_MS = parseInt(process.env.WATCH_INTERVAL || "15", 10) * 1000;

type Prev = {
  online?: boolean; appId?: string; appName?: string; charging?: boolean;
  lowNotified?: boolean; lastAppAt?: number;
};
const prev = new Map<string, Prev>();

function emit(deviceId: string, kind: string, title: string, body: string, meta: any = {}, force = false) {
  try {
    // 抖动抑制：窗口内重复的同类型事件只入库、不通知
    let notify = 1;
    const cd = cooldownFor(kind);
    if (!force && cd > 0) {
      const last = getLastEventByKind.get(deviceId, kind) as any;
      if (last && Date.now() - Date.parse(last.created_at) < cd) notify = 0;
    }
    insertEvent.run(new Date().toISOString(), deviceId, kind, title, body, JSON.stringify(meta), notify);
    console.log(`[watch] ${kind}${notify ? "" : "(静默)"} ${title} — ${body}`);
  } catch (e: any) {
    console.error("[watch] insert failed:", e.message);
  }
}

function shortName(st: any): string {
  return st.device_name || st.device_id;
}

function batt(st: any): number | null {
  try {
    const extra = JSON.parse(st.extra || "{}");
    return typeof extra.battery_percent === "number" ? extra.battery_percent : null;
  } catch { return null; }
}
function charging(st: any): boolean {
  try { return JSON.parse(st.extra || "{}").battery_charging === true; } catch { return false; }
}

function tick() {
  if (WATCH_DEVICES.length === 0) return;
  let rows: any[];
  try { rows = listDeviceStates.all() as any[]; } catch { return; }

  for (const st of rows) {
    if (!WATCH_DEVICES.includes(st.device_id)) continue;
    const p = prev.get(st.device_id) || {};
    const online = st.is_online === 1;
    const name = shortName(st);
    const now = Date.now();

    // 上线 / 离线
    if (p.online !== undefined && p.online !== online) {
      if (online) emit(st.device_id, "online", `${name} 上线了`, `当前：${st.app_name || "未知"}`);
      else emit(st.device_id, "offline", `${name} 离线了`, `最后活跃：${st.last_seen_at}`);
    }

    if (online) {
      // 隐私模式
      if (st.app_id === "private") {
        if (p.appId && p.appId !== "private") {
          emit(st.device_id, "privacy", `${name} 进入隐私模式`, "已隐藏具体应用");
        }
      } else if (p.appId !== undefined && p.appId !== st.app_id) {
        // idle/unknown 不是"打开了应用"，不发通知
        const SKIP_APP = ["idle", "unknown", "private", "android"];
        if (!SKIP_APP.includes(st.app_id)) {
          emit(st.device_id, "app", `${name} 打开了 ${st.app_name || st.app_id}`,
               `时间 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`,
               { app_id: st.app_id, app_name: st.app_name });
        }
      } else if (p.appId === undefined) {
        // 首次见到：不通知，只记录基线
      }

      // 充电
      const chg = charging(st);
      if (p.charging !== undefined && p.charging !== chg) {
        const b = batt(st);
        emit(st.device_id, chg ? "charging" : "unplugged",
             `${name} ${chg ? "开始充电" : "拔掉充电器"}`,
             b === null ? "" : `当前电量 ${b}%`);
      }
      p.charging = chg;

      // 低电量
      const b = batt(st);
      if (b !== null) {
        if (b < BATTERY_LOW && !p.lowNotified) {
          emit(st.device_id, "battery_low", `${name} 电量偏低`, `剩余 ${b}%`);
          p.lowNotified = true;
        } else if (b >= BATTERY_LOW + 5) {
          p.lowNotified = false;
        }
      }
    }

    p.online = online;
    p.appId = st.app_id;
    p.appName = st.app_name;
    prev.set(st.device_id, p);
  }
}

console.log(`[watch] 监听设备: ${WATCH_DEVICES.join(",") || "(未配置)"} | 低电量阈值 ${BATTERY_LOW}% | app冷却 ${COOLDOWN_MS / 1000}s | 状态冷却 ${STATE_COOLDOWN_MS / 1000}s`);
setInterval(tick, INTERVAL_MS);
setTimeout(tick, 3000);
