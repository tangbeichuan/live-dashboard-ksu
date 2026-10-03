#!/system/bin/sh
STATE=/data/adb/live-dashboard
[ -f "$STATE/reporter.pid" ] && kill "$(cat "$STATE/reporter.pid")" 2>/dev/null
rm -rf "$STATE"
