#!/system/bin/sh
MODDIR=${0%/*}
[ -f "$MODDIR/config.sh" ] && . "$MODDIR/config.sh"

STATE=/data/adb/live-dashboard
mkdir -p "$STATE"
BUSYBOX="$(command -v busybox 2>/dev/null || true)"
[ -x "$BUSYBOX" ] || BUSYBOX=/data/adb/ksu/bin/busybox
LOG="$STATE/reporter.log"
PIDF="$STATE/reporter.pid"
SQL3="$MODDIR/bin/sqlite3-arm64"
[ -f "$SQL3" ] && chmod 755 "$SQL3"
PRIVACY_FLAG="${PRIVACY_FLAG:-$STATE/privacy}"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

if [ -f "$PIDF" ]; then OLD=$(cat "$PIDF" 2>/dev/null); [ -n "$OLD" ] && kill "$OLD" 2>/dev/null; sleep 1; fi
echo $$ > "$PIDF"
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt 300000 ]; then
  tail -n 400 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi

CURL=""; CURL_OPTS=""
if [ -x "$MODDIR/bin/curl" ]; then
  CURL="$MODDIR/bin/curl"; CAB="$STATE/ca.pem"
  [ -s "$CAB" ] || cat /system/etc/security/cacerts/* > "$CAB" 2>/dev/null
  CURL_OPTS="--cacert $CAB"
elif command -v curl >/dev/null 2>&1; then CURL="curl"; fi
BB=""
for C in /data/adb/ksu/bin/busybox /data/adb/magisk/busybox /system/xbin/busybox /system/bin/busybox; do
  [ -x "$C" ] && BB="$C" && break
done
log "start v1.16: curl=$CURL sqlite3=$([ -f "$SQL3" ] && echo yes || echo no) privacy_apps='${PRIVACY_APPS:-}' timeout=${PRIVACY_TIMEOUT:-0}"

esc() { printf '%s' "$1" | tr -d '"\\' | tr '\n\r' '  '; }
b64() { base64 "$1" 2>/dev/null | tr -d '\n'; }

post_raw() {
  P="$1"; B="$2"; U="$3"
  if [ -n "$CURL" ]; then
    C=$($CURL -s -m 20 $CURL_OPTS -o /dev/null -w '%{http_code}' -X POST "$U$P" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      --data-binary "$B" 2>/dev/null)
    case "$C" in 2*) return 0 ;; *) log "post $P -> HTTP ${C:-none}"; return 1 ;; esac
  fi
  if [ -n "$BB" ]; then
    $BB wget -q -T 15 -O /dev/null --header="Authorization: Bearer $TOKEN" \
      --header="Content-Type: application/json" --post-data="$B" "$U$P" >/dev/null 2>&1 && return 0
    return 1
  fi
  command -v wget >/dev/null 2>&1 && wget -q -T 15 -O /dev/null --header="Authorization: Bearer $TOKEN" \
    --header="Content-Type: application/json" --post-data="$B" "$U$P" >/dev/null 2>&1
}

get_probe() {
  U="$1"
  if [ -n "$CURL" ]; then
    C=$($CURL -s -m 12 -o /dev/null -w '%{http_code}' $CURL_OPTS -H "Authorization: Bearer $TOKEN" "$U/api/consent" 2>/dev/null)
    [ "$C" = "200" ] && return 0
    return 1
  fi
  if [ -n "$BB" ]; then
    $BB wget -q -T 12 -O - --header="Authorization: Bearer $TOKEN" "$U/api/consent" 2>/dev/null | grep -q "required" && return 0
    return 1
  fi
  return 1
}

SERVER=""
pick_server() {
  for U in "$SERVER_PRIMARY" "$SERVER_FALLBACK"; do
    case "$U" in https://*) [ -n "$CURL" ] || continue ;; esac
    if get_probe "$U"; then SERVER="$U"; log "server=$U"; return 0; fi
  done
  return 1
}

push_file() {
  F="$1"; TAG="$2"
  [ -s "$F" ] || return 1; [ -n "$SERVER" ] || return 1
  D="$STATE/chunks"; rm -rf "$D"; mkdir -p "$D"
  split -b 60000 "$F" "$D/p." 2>/dev/null || cp "$F" "$D/p.aa"
  I=0
  for C in "$D"/p.*; do
    I=$((I+1))
    post_raw /api/diag "{\"tag\":\"$TAG\",\"part\":$I,\"b64\":\"$(b64 "$C")\"}" "$SERVER" || log "diag part $I failed"
  done
  rm -rf "$D"; log "diag pushed: $TAG ($I parts)"
}

# ---- 隐私模式 ----
# 返回 0 = 当前处于隐私模式（手动开关命中，或超时内仍有效）
privacy_flag_on() {
  [ -f "$PRIVACY_FLAG" ] || return 1
  if [ "${PRIVACY_TIMEOUT:-0}" -gt 0 ] 2>/dev/null; then
    MT=$(stat -c %Y "$PRIVACY_FLAG" 2>/dev/null || echo 0)
    if [ "$MT" -gt 0 ] && [ $(( $(date +%s) - MT )) -ge "$PRIVACY_TIMEOUT" ]; then
      rm -f "$PRIVACY_FLAG"; log "privacy: 超时自动关闭"; return 1
    fi
  fi
  return 0
}
# $1=包名；命中 PRIVACY_APPS 中任一项（部分匹配）返回 0
privacy_app_hit() {
  [ -n "${PRIVACY_APPS:-}" ] || return 1
  for P in $(printf '%s' "$PRIVACY_APPS" | tr ',' ' '); do
    [ -z "$P" ] && continue
    case "$1" in *"$P"*) return 0 ;; esac
  done
  return 1
}


# ---- 应用使用时长 / 屏幕时间（口径对齐系统 UsageStats） ----
# 关键点：
#  1) 事件时间戳是"本地墙上时间"，所以今日基准 = ((NOW+OFF)/86400)*86400（不减 OFF）
#  2) 儒略日公式返回值要减 2440588 才是 Unix 天数
#  3) 熄屏/锁屏要停止计时，亮屏/解锁要"恢复"计时（否则漏算大量时间）
report_usage() {
  [ "${USAGE_ENABLE:-1}" = "1" ] || return 0
  [ -n "$SERVER" ] || return 1

  NOW=$(date +%s); TZOFF=$(date +%z); TODAY=$(date +%Y-%m-%d)
  SG=$(printf '%s' "$TZOFF" | cut -c1)
  ZH=$(printf '%s' "$TZOFF" | cut -c2-3); ZM=$(printf '%s' "$TZOFF" | cut -c4-5)
  HH=${ZH#0}; MM=${ZM#0}; [ -z "$HH" ] && HH=0; [ -z "$MM" ] && MM=0
  OFF=$(( HH*3600 + MM*60 )); [ "$SG" = "-" ] && OFF=$(( 0 - OFF ))
  DSW=$(( ((NOW+OFF)/86400)*86400 ))     # 墙上时间约定下的今日 00:00
  NOWW=$(( NOW+OFF ))

  PA="$STATE/usage-pa.txt"; AL="$STATE/usage-al.txt"
  dumpsys usagestats 2>/dev/null \
    | sed -n 's/.*time="\([0-9-]*\) \([0-9:]*\)" type=\([A-Z_]*\) package=\([A-Za-z0-9_.]*\).*/\1 \2 \3 \4/p' > "$PA.raw"
  dumpsys usagestats 2>/dev/null \
    | sed -n 's/.*time="\([0-9-]*\) \([0-9:]*\)" type=\([A-Z_]*\).*/\1 \2 \3/p' > "$AL.raw"
  # ⚠ 必须排序 + 去重：dump 里的事件不是按时间排的，且有大量重复行，
  #   直接配对会把同一段时长重复累加（实测差异近一倍）。
  sort -u "$PA.raw" > "$PA"; rm -f "$PA.raw"
  sort -u "$AL.raw" > "$AL"; rm -f "$AL.raw"
  [ -s "$PA" ] || { log "usage: no events"; return 1; }

  # 亮屏 / 解锁
  SCREEN_UNLOCK=$(awk -v ds="$DSW" -v now="$NOWW" '
    function days(y,mo,d, a,b,m,yy){ if(mo<=2){yy=y-1;m=mo+12}else{yy=y;m=mo} a=int(yy/100); b=2-a+int(a/4); return int(365.25*(yy+4716))+int(30.6001*(m+1))+d+b-1524-2440588 }
    { split($1,D,"-"); split($2,T,":"); ts=days(D[1],D[2],D[3])*86400+T[1]*3600+T[2]*60+T[3] }
    ts>=ds{
      if($3=="KEYGUARD_HIDDEN"){ unl=ts }
      else if($3=="KEYGUARD_SHOWN"){ if(unl>0&&ts>unl) unlocked+=(ts-unl); unl=0 }
      else if($3=="SCREEN_INTERACTIVE"){ son=ts }
      else if($3=="SCREEN_NON_INTERACTIVE"){ if(son>0&&ts>son) screen+=(ts-son); son=0 }
    }
    END{ if(unl>0&&now>unl) unlocked+=now-unl; if(son>0&&now>son) screen+=now-son
      printf "%.1f %.1f", screen/60, unlocked/60 }' "$AL")
  SCR=$(printf '%s' "$SCREEN_UNLOCK" | cut -d' ' -f1)
  UNL=$(printf '%s' "$SCREEN_UNLOCK" | cut -d' ' -f2)

  # 各 App 前台时长（带熄屏恢复）
  RECS=$(awk -v ds="$DSW" -v now="$NOWW" -v excl="${USAGE_EXCLUDE:-}" '
    function days(y,mo,d, a,b,m,yy){ if(mo<=2){yy=y-1;m=mo+12}else{yy=y;m=mo} a=int(yy/100); b=2-a+int(a/4); return int(365.25*(yy+4716))+int(30.6001*(m+1))+d+b-1524-2440588 }
    function flush(e,  s){ if(cur==""||st==0){ st=0; return } s=st; if(s<ds) s=ds; if(e>s) acc[cur]+=e-s; st=0 }
    BEGIN{ nx=split(excl,E,","); for(i=1;i<=nx;i++){ gsub(/^ +| +$/,"",E[i]); if(E[i]!="") ex[E[i]]=1 } counting=0 }
    { split($1,D,"-"); split($2,T,":"); ts=days(D[1],D[2],D[3])*86400+T[1]*3600+T[2]*60+T[3] }
    ts>=ds{
      if($3=="ACTIVITY_RESUMED"){ flush(ts); cur=$4; if(counting) st=ts }
      else if(($3=="ACTIVITY_PAUSED"||$3=="ACTIVITY_STOPPED")&&$4==cur){ flush(ts); if(counting) st=ts }   # 继续给"最后已知前台应用"计时（不重置 st 会漏算）
      else if($3=="SCREEN_INTERACTIVE"||$3=="KEYGUARD_HIDDEN"){ if(!counting){ counting=1; if(cur!="") st=ts } }
      else if($3=="SCREEN_NON_INTERACTIVE"||$3=="KEYGUARD_SHOWN"){ if(counting) flush(ts); counting=0 }
    }
    END{ if(counting) flush(now); out=""
      for(p in acc){ if(p in ex) continue; m=acc[p]/60; if(m<0.5) continue
        out=out (out==""?"":",") "{\"app_id\":\"" p "\",\"minutes\":" sprintf("%.1f",m) "}" }
      print out }' "$PA")
  rm -f "$PA" "$AL"

  [ -z "$RECS" ] && { log "usage: nothing to report"; return 1; }
  N=$(printf '%s' "$RECS" | tr ',' '\n' | wc -l)
  BODY="{\"date\":\"$TODAY\",\"screen_minutes\":${SCR:-0},\"unlocked_minutes\":${UNL:-0},\"records\":[$RECS]}"
  if post_raw /api/usage "$BODY" "$SERVER"; then
    log "usage ok: $N apps | 亮屏 ${SCR}m 解锁 ${UNL}m"
  else
    log "usage post failed"
  fi
}

# ---- 事件通知：轮询 /api/events → 本机原生通知 ----
ICON_online="🔵"; ICON_offline="⚫"; ICON_app="📱"; ICON_charging="🔋"
ICON_unplugged="🔌"; ICON_battery_low="🪫"; ICON_privacy="🔒"

notify() {
  [ "${EVENT_NOTIFY:-1}" = "1" ] || return 0
  T="$1"; TAG="$2"; B="$3"
  # ⚠ 关键：必须以 shell(uid 2000) 身份发送。
  #   以 root 身份执行时，系统解析出的包名是 "root"，PackageManager 查不到该应用
  #   → logcat: "Cannot fix notification / NameNotFoundException: root" → 通知被静默丢弃。
  #   降权到 2000 后包名变成 com.android.shell，通知正常进入系统。
  if [ -x "$BUSYBOX" ]; then
    "$BUSYBOX" setuidgid 2000 /system/bin/cmd notification post -S bigtext -t "$T" "$TAG" "$B" >/dev/null 2>&1 && return 0
  fi
  su 2000 -c "cmd notification post -S bigtext -t \"$T\" \"$TAG\" \"$B\"" >/dev/null 2>&1 && return 0
  log "notify failed (uid drop)"
}

poll_events() {
  [ "${EVENT_ENABLE:-1}" = "1" ] || return 0
  [ -n "$SERVER" ] || return 1
  [ -n "$CURL" ] || return 1

  SF="$STATE/events.since"
  FIRST=0
  [ -f "$SF" ] || FIRST=1
  SINCE=$(cat "$SF" 2>/dev/null || echo 0)

  RESP=$($CURL -s -m 15 $CURL_OPTS -H "Authorization: Bearer $TOKEN" \
         "$SERVER/api/events?since=$SINCE&limit=30" 2>/dev/null)
  case "$RESP" in *'"events"'*) ;; *) return 1 ;; esac

  printf '%s' "$RESP" | awk '{gsub(/},\{/,"}\n{")}1' | while IFS= read -r L; do
    ID=$(printf '%s' "$L" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
    KIND=$(printf '%s' "$L" | sed -n 's/.*"kind":"\([^"]*\)".*/\1/p')
    TITLE=$(printf '%s' "$L" | sed -n 's/.*"title":"\([^"]*\)".*/\1/p')
    BODY=$(printf '%s' "$L" | sed -n 's/.*"body":"\([^"]*\)".*/\1/p')
    NOTIFY=$(printf '%s' "$L" | sed -n 's/.*"notify":\([0-9]*\).*/\1/p')
    [ -z "$ID" ] && continue
    echo "$ID" > "$SF"
    # notify=0：服务端判定为"抖动"（同设备同类型在冷却窗口内），只记日志、不弹通知
    if [ "$NOTIFY" = "0" ]; then
      log "event#$ID [静默] $TITLE"
      continue
    fi
    [ "$FIRST" = "1" ] && continue          # 首次运行只对齐游标，避免一次性弹一堆旧通知
    LOGLINE="event#$ID [$KIND] $TITLE | $BODY"
    log "$LOGLINE"
    case "$KIND" in
      online)      notify "$ICON_online $TITLE"       "ld-$ID" "$BODY" ;;
      offline)     notify "$ICON_offline $TITLE"      "ld-$ID" "$BODY" ;;
      app)         notify "$ICON_app $TITLE"          "ld-$ID" "$BODY" ;;
      charging)    notify "$ICON_charging $TITLE"     "ld-$ID" "$BODY" ;;
      unplugged)   notify "$ICON_unplugged $TITLE"    "ld-$ID" "$BODY" ;;
      battery_low) notify "$ICON_battery_low $TITLE"  "ld-$ID" "$BODY" ;;
      privacy)     notify "$ICON_privacy $TITLE"      "ld-$ID" "$BODY" ;;
      *)           notify "$TITLE"                    "ld-$ID" "$BODY" ;;
    esac
  done
  [ "$FIRST" = "1" ] && log "events: 首次运行，游标已对齐到 #$(cat "$SF" 2>/dev/null || echo 0)"
  return 0
}

# ---- 健康数据 ----
report_health() {
  [ "${HEALTH_ENABLE:-1}" = "1" ] || return 0
  [ -n "$SERVER" ] || return 1
  [ -x "$SQL3" ] || return 1

  NOW=$(date +%s); TZOFF=$(date +%z); TODAY=$(date +%Y-%m-%d)
  SG=$(printf '%s' "$TZOFF" | cut -c1)
  ZH=$(printf '%s' "$TZOFF" | cut -c2-3); ZM=$(printf '%s' "$TZOFF" | cut -c4-5)
  HH=${ZH#0}; MM=${ZM#0}; [ -z "$HH" ] && HH=0; [ -z "$MM" ] && MM=0
  OFF=$(( HH*3600 + MM*60 )); [ "$SG" = "-" ] && OFF=$(( 0 - OFF ))
  ISO="${TODAY}T00:00:00${SG}${ZH}:${ZM}"
  if [ "$OFF" -lt 0 ]; then OFFS="$OFF seconds"; else OFFS="+$OFF seconds"; fi
  FMT="%Y-%m-%dT%H:%M:%S${SG}${ZH}:${ZM}"

  ACCT=$(ls -d /data/data/com.mi.health/databases/[0-9]* 2>/dev/null | head -1)
  FD="$ACCT/cn/fitness_data"

  D="$STATE/hcdb"; rm -rf "$D"; mkdir -p "$D"
  for SRC in /data/data/com.miui.rom/databases/Steps.db /data/data/com.mi.health/databases/fitness_user; do
    cp -f "$SRC" "$D/" 2>/dev/null; cp -f "$SRC-wal" "$D/" 2>/dev/null; cp -f "$SRC-shm" "$D/" 2>/dev/null
  done
  STEPS=""; PROF=""
  [ -f "$D/Steps.db" ] && STEPS=$("$SQL3" "$D/Steps.db" "select ifnull(sum(_steps),0) from StepsTable where date((_begin_time/1000)+$OFF,'unixepoch')='$TODAY';" 2>/dev/null)
  [ -f "$D/fitness_user" ] && PROF=$("$SQL3" "$D/fitness_user" "select height||'|'||weight from user_info_profile limit 1;" 2>/dev/null)
  rm -rf "$D"
  H=$(printf '%s' "$PROF" | cut -d'|' -f1); WT=$(printf '%s' "$PROF" | cut -d'|' -f2)

  RECS=""
  add() { A=$(printf '%s' "$1" | sed 's/^\[//; s/\]$//'); [ -z "$A" ] && return 0; RECS="$RECS${RECS:+,}$A"; }

  [ -n "$STEPS" ] && add "[{\"type\":\"steps\",\"value\":$STEPS,\"unit\":\"count\",\"timestamp\":\"$ISO\"}]"
  [ -n "$H" ] && add "[{\"type\":\"height\",\"value\":$H,\"unit\":\"cm\",\"timestamp\":\"$ISO\"}]"

  if [ -f "$FD" ]; then
    add "$("$SQL3" "$FD" "select ifnull(json_group_array(json_object('type','heart_rate','value',bpm,'unit','bpm','timestamp',ts)),'[]') from (select round(avg(json_extract(value,'\$.bpm'))) bpm, strftime('$FMT',(time/3600)*3600+$OFF,'unixepoch') ts from hr_record where key in ('heart_rate','single_heart_rate','high_heart_rate') and isDeleted=0 and date(time,'unixepoch','$OFFS')=date('now','$OFFS') group by (time/3600));" 2>/dev/null)"
    add "$("$SQL3" "$FD" "select ifnull(json_group_array(json_object('type','sleep','value',json_extract(value,'\$.duration'),'unit','min','timestamp',strftime('$FMT',json_extract(value,'\$.bedtime')+$OFF,'unixepoch'),'end_time',strftime('$FMT',json_extract(value,'\$.wake_up_time')+$OFF,'unixepoch'))),'[]') from sleep_segment where key='sleep' and isDeleted=0 and json_extract(value,'\$.duration') is not null and json_extract(value,'\$.bedtime') >= $((NOW-2*86400));" 2>/dev/null)"
    add "$("$SQL3" "$FD" "select ifnull(json_group_array(json_object('type','oxygen_saturation','value',json_extract(value,'\$.spo2'),'unit','%','timestamp',strftime('$FMT',time+$OFF,'unixepoch'))),'[]') from spo2_record where key='spo2' and isDeleted=0 and date(time,'unixepoch','$OFFS')=date('now','$OFFS');" 2>/dev/null)"
    add "$("$SQL3" "$FD" "select ifnull(json_group_array(json_object('type','weight','value',weight,'unit','kg','timestamp',strftime('$FMT',time+$OFF,'unixepoch'))),'[]') from (select weight,time from weight_item_record where isDeleted=0 and weight>0 order by time desc limit 1);" 2>/dev/null)"
  fi
  [ -n "$WT" ] && add "[{\"type\":\"weight\",\"value\":$WT,\"unit\":\"kg\",\"timestamp\":\"$ISO\"}]"

  [ -z "$RECS" ] && { log "health: no data"; return 1; }
  if post_raw /api/health-data "{\"records\":[$RECS]}" "$SERVER"; then
    log "health ok: steps=${STEPS:-NA} (+hr/sleep/spo2/weight if present)"
  else
    log "health post failed"
  fi
}

pick_server || log "WARN: no transport yet"
[ -n "$SERVER" ] && report_health   # 启动/重载时先上报一次健康数据
[ -n "$SERVER" ] && poll_events     # 首次运行对齐事件游标（不弹历史通知）

LAST_STATE=""; LAST_SENT=0; FAILS=0; LAST_HEALTH=0; LAST_USAGE=0; LAST_EVENT=0
while true; do
  PKG=$(dumpsys activity activities 2>/dev/null | grep -m1 -E 'topResumedActivity|mResumedActivity' | tr ' ' '\n' | grep -m1 -E '^[A-Za-z0-9_][A-Za-z0-9_.]*/' | cut -d/ -f1)
  [ -z "$PKG" ] && PKG=$(dumpsys window 2>/dev/null | grep -m1 -E 'mCurrentFocus|mFocusedApp' | tr ' ' '\n' | grep -m1 -E '^[A-Za-z0-9_][A-Za-z0-9_.]*/' | cut -d/ -f1)
  WAKE=$(dumpsys power 2>/dev/null | grep -m1 -o 'mWakefulness=[A-Za-z]*' | cut -d= -f2)
  [ "$WAKE" != "Awake" ] && PKG="idle"
  [ -z "$PKG" ] && PKG="unknown"

  # 隐私判定：手动开关 > 按 App 名单
  PRIV=0; PRIV_WHY=""
  if privacy_flag_on; then PRIV=1; PRIV_WHY="flag"
  elif privacy_app_hit "$PKG"; then PRIV=1; PRIV_WHY="app:$PKG"; fi
  # 状态里包含隐私位，切换瞬间就能立即上报（不用等心跳）
  if [ "$PRIV" = "1" ]; then CUR="private|$PKG"; else CUR="normal|$PKG"; fi

  NOW=$(date +%s)
  if [ "$CUR" != "$LAST_STATE" ] || [ $((NOW - LAST_SENT)) -ge "$HEARTBEAT" ] || [ -z "$SERVER" ]; then
    BAT=$(dumpsys battery 2>/dev/null | grep -m1 -o 'level: [0-9]*' | grep -o '[0-9]*'); [ -z "$BAT" ] && BAT=0
    if dumpsys battery 2>/dev/null | grep -qE 'AC powered: true|USB powered: true|Wireless powered: true'; then CHG=true; else CHG=false; fi

    if [ "$PRIV" = "1" ]; then
      # 隐私模式：不报应用、不报标题、不报音乐
      BODY="{\"app_id\":\"private\",\"window_title\":\"\",\"timestamp\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\",\"extra\":{\"battery_percent\":$BAT,\"battery_charging\":$CHG}}"
    else
      MUSIC=""
      MS=$(dumpsys media_session 2>/dev/null)
      if printf '%s' "$MS" | grep -q 'state=PlaybackState {state=3'; then
        ML=$(printf '%s' "$MS" | grep -m1 'metadata:')
        D=${ML#*description=}; D=${D%%, duration=*}
        MAPP=$(printf '%s' "$MS" | grep -m1 -o 'package=[A-Za-z0-9_.]*' | cut -d= -f2)
        if [ -n "$D" ] && [ "$D" != "$ML" ]; then
          MT=$(esc "${D%%, *}"); MA=$(esc "${D#*, }"); [ "$MA" = "$MT" ] && MA=""
          MUSIC=",\"music\":{\"title\":\"$MT\",\"artist\":\"$MA\",\"app\":\"$(esc "$MAPP")\"}"
        fi
      fi
      TITLE=$(dumpsys window 2>/dev/null | grep -m1 -o 'mTitle=[^,}]*' | cut -d= -f2 | tr -d '"\\')
      BODY="{\"app_id\":\"$(esc "$PKG")\",\"window_title\":\"$(esc "$TITLE")\",\"timestamp\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\",\"extra\":{\"battery_percent\":$BAT,\"battery_charging\":$CHG$MUSIC}}"
    fi

    if [ -n "$SERVER" ]; then
      if post_raw /api/report "$BODY" "$SERVER"; then
        [ "$LAST_STATE" != "$CUR" ] && log "state: $CUR ${PRIV_WHY:+[privacy:$PRIV_WHY]}"
        LAST_STATE="$CUR"; LAST_SENT=$NOW; FAILS=0
      else
        FAILS=$((FAILS+1)); log "post failed x$FAILS"
        [ $FAILS -ge 3 ] && SERVER="" && pick_server
      fi
    else
      pick_server
    fi
  fi

  # 应用使用时长：每 USAGE_INTERVAL 秒（默认 600s = 10 分钟）
  if [ $((NOW - LAST_USAGE)) -ge "${USAGE_INTERVAL:-600}" ]; then
    report_usage; LAST_USAGE=$NOW
  fi

  # 事件通知：每 EVENT_INTERVAL 秒（默认 30s）轮询一次
  if [ $((NOW - LAST_EVENT)) -ge "${EVENT_INTERVAL:-30}" ]; then
    poll_events || true; LAST_EVENT=$NOW
  fi

  # 健康数据上报：距上次满 HEALTH_INTERVAL 秒（默认 300s = 5 分钟）
  if [ $((NOW - LAST_HEALTH)) -ge "${HEALTH_INTERVAL:-300}" ]; then
    report_health; LAST_HEALTH=$NOW
  fi
  sleep "$INTERVAL"
done
