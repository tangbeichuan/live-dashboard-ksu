#!/system/bin/sh
# KernelSU/Magisk 模块「操作」按钮：一键切换隐私模式
STATE=/data/adb/live-dashboard
F="$STATE/privacy"
mkdir -p "$STATE"
if [ -f "$F" ]; then
  rm -f "$F"
  echo "✅ 隐私模式：已关闭（恢复上报具体应用）"
else
  date +%s > "$F"
  echo "🔒 隐私模式：已开启（只显示「隐私模式」，不报应用/标题/音乐）"
fi
