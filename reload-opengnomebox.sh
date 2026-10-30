#!/usr/bin/env bash
# 热重载 Open Bar：停用 → 卸载 → 重装 → 启用
# 适用于改了 .js / schema 代码后，无需注销重登。
# 注意：只动 Open Bar 自己的扩展目录，不碰系统文件。
set -euo pipefail

UUID="opengnomebox@lyf"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/opengnomebox@lyf"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

if [ ! -d "$SRC" ]; then
    echo "错误：找不到源目录 $SRC" >&2
    exit 1
fi

echo "==> 停用 $UUID"
gnome-extensions disable "$UUID" 2>/dev/null || true
sleep 1

echo "==> 重新编译 schema"
glib-compile-schemas "$SRC/schemas/"

echo "==> 卸载旧目录"
rm -rf "$DEST"

echo "==> 重新安装（代码 + 编译后 schema 同批复制）"
mkdir -p "$(dirname "$DEST")"
cp -r "$SRC" "$DEST"

echo "==> 启用 $UUID"
gnome-extensions enable "$UUID"

sleep 2
echo
echo "==> 结果"
gnome-extensions info "$UUID" 2>&1 | grep -iE "状态|版本|错误" || true
echo
echo "提示：若仍异常，查看日志： journalctl --user -f | grep -i wallhub"
