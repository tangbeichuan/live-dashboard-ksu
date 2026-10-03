# ============ Live Dashboard Reporter 配置（改完重启手机或重跑 service.sh 生效） ============

# 服务器地址：优先用第一个（HTTPS，流量下也能上报）；失败时回落到局域网地址
SERVER_PRIMARY="https://example.dynv6.net"
SERVER_FALLBACK="http://192.168.1.100:3000"

# 设备身份：对应服务端 DEVICE_TOKEN_4（服务端 /etc/live-dashboard.env 里）
TOKEN="<把服务端 DEVICE_TOKEN_n 的第一段填这里>"
DEVICE_ID="my-phone"
DEVICE_NAME="我的手机"
PLATFORM="android"

# ---------------- 活动上报（"正在用什么 App"） ----------------
# INTERVAL  : 轮询前台应用的间隔（秒）。越小越实时，越费电。默认 5。
# HEARTBEAT : 前台应用没变化时，也至少每 N 秒上报一次（心跳，用来表示设备在线）。
#             ⚠ 服务端 60 秒收不到上报就判定"离线"，所以不要设成大于 60 的值。
INTERVAL=5
HEARTBEAT=60

# ---------------- 隐私模式 ----------------
# 开启后：只上报 app_id=private（面板显示"隐私模式"），
#         窗口标题清空、音乐（歌名/歌手）也不上报。健康数据不受影响。
#
# 三种开启方式（任一生效）：
#   1) 手动：KernelSU/Magisk 模块页面点「操作」按钮一键开关；
#            或自己建/删这个文件： /privacy
#   2) 按 App：把包名填进 PRIVACY_APPS（逗号分隔，支持部分匹配）
#   3) 超时：手动开启后经过 PRIVACY_TIMEOUT 秒自动关闭（0=不自动关）
PRIVACY_APPS=""
# 例：PRIVACY_APPS="com.tencent.mm,com.eg.android.AlipayGphone,com.android.bank"
PRIVACY_TIMEOUT=0
PRIVACY_FLAG="/data/adb/live-dashboard/privacy"

# ---------------- 应用使用时长统计 ----------------
# 从系统的 usagestats 事件流（ACTIVITY_RESUMED/PAUSED）配对计算"前台时长"，
# 上报到面板的统计区块（按日期查看排行）。比"前台采样"更准：不会漏掉快速切换。
USAGE_ENABLE=1
USAGE_INTERVAL=600        # 上报间隔（秒）；默认 10 分钟
# 不算作"使用"的包（桌面/系统界面/息屏显示等）
USAGE_EXCLUDE="com.miui.home,com.android.systemui,miui.systemui.plugin,com.miui.aod,com.android.keyguard,com.tencent.tmgp.dfm"

# ---------------- 事件通知（只发到"我这边"） ----------------
# 服务端 watcher 会监听 WATCH_DEVICES 里的设备，把变化写成事件；
# 本机轮询 /api/events，再用 root 的 cmd notification post 弹原生通知。
# 事件内容不在面板上公开，只有带 token 的 /api/events 能读到。
EVENT_ENABLE=1
EVENT_INTERVAL=30         # 轮询间隔（秒）
EVENT_NOTIFY=1            # 1=弹系统通知；0=只写日志

# ---------------- 健康数据上报 ----------------
# HEALTH_ENABLE   : 1=启用，0=关闭
# HEALTH_INTERVAL : 上报间隔（秒）。默认 300 = 5 分钟。
#   每次上报：steps 当天步数 / height+weight 档案 / heart_rate 当天小时均值
#             sleep 最近 2 天睡眠段(单位分钟) / oxygen_saturation 当天血氧 / weight 最新实测
HEALTH_ENABLE=1
HEALTH_INTERVAL=300
