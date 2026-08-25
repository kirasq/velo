#!/usr/bin/env bash
#
# Velo 签名构建脚本（macOS）
# ---------------------------------------------------------------------------
# 作用：从 macOS Keychain 读取 Tauri 更新签名口令，启动带签名的 tauri build，
#       并在构建完成后自动生成 updater 所需的 latest.json（Tauri v2 不会自动生成）。
#
# 前置条件（一次性）：
#   1) 私钥已存放于 ~/.tauri/velo_key_cli.key（加密，权限 600）
#   2) 口令已存入 Keychain：
#        security add-generic-password \
#          -a velo -s velo-tauri-updater-signing -w '你的口令' \
#          -T /usr/bin/security -T /usr/bin/codesign
#   3) tauri.conf.json 中 plugins.updater.pubkey 为 .pub 文件内容（base64-of-minisign 信封）
#
# 用法：
#   ./scripts/sign-build.sh            # 仅构建 + 生成 latest.json
#   ./scripts/sign-build.sh --upload   # 构建后额外上传到 GitHub Release（需 gh 已登录）
#   ./scripts/sign-build.sh --tag v0.4.22   # 指定 release tag（配合 --upload）
#
# 安全：本脚本不写入任何明文口令；口令仅在运行时从 Keychain 取出并注入环境变量。
# ---------------------------------------------------------------------------
set -euo pipefail

# ---- 配置 ----
KEYCHAIN_ACCOUNT="velo"
KEYCHAIN_SERVICE="velo-tauri-updater-signing"
PRIV_KEY="${HOME}/.tauri/velo_key_cli.key"
REPO="kirasq/velo"
APP_NAME="Velo"

# ---- 解析参数 ----
UPLOAD=0
TAG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --upload) UPLOAD=1; shift ;;
    --tag)    TAG="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

# ---- 校验私钥 ----
if [[ ! -f "$PRIV_KEY" ]]; then
  echo "错误：缺少私钥文件 $PRIV_KEY" >&2
  exit 1
fi

# ---- 从 Keychain 取口令 ----
PASS="$(security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)" || {
  echo "错误：无法从 Keychain 读取签名口令。" >&2
  echo "请先执行：security add-generic-password -a velo -s velo-tauri-updater-signing -w '你的口令'" >&2
  exit 1
}

# ---- 注入环境变量并构建 ----
export TAURI_SIGNING_PRIVATE_KEY="$PRIV_KEY"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$PASS"

cd "$(dirname "$0")/.."
echo ">>> 开始签名构建（口令已从 Keychain 注入）..."
npm run tauri build "$@"

# ---- 生成 latest.json（Tauri v2 不自动生成）----
BUNDLE_DIR="src-tauri/target/release/bundle"
SIG_FILE="${BUNDLE_DIR}/macos/${APP_NAME}.app.tar.gz.sig"
if [[ ! -f "$SIG_FILE" ]]; then
  echo "警告：未找到 $SIG_FILE，跳过 latest.json 生成。" >&2
  exit 0
fi

SIG="$(cat "$SIG_FILE")"
VERSION="$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

python3 - "$SIG" "$VERSION" "$NOW" <<'PY'
import sys, json
sig, version, now = sys.argv[1], sys.argv[2], sys.argv[3]
data = {
    "version": version,
    "notes": f"{'Velo 邮件客户端'} v{version}（macOS aarch64）发布：包含自动更新签名包与离线安装包。未做 Apple 公证，首次打开需在『系统设置-隐私与安全性』中手动允许。",
    "pub_date": now,
    "platforms": {
        "darwin-aarch64": {
            "signature": sig,
            "url": f"https://github.com/{ 'kirasq/velo' }/releases/latest/download/Velo.app.tar.gz"
        }
    }
}
out = "src-tauri/target/release/bundle/latest.json"
with open(out, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
print(">>> 已生成", out)
PY

# ---- 可选：上传到 GitHub Release ----
if [[ "$UPLOAD" -eq 1 ]]; then
  [[ -z "$TAG" ]] && { echo "错误：--upload 需配合 --tag <版本号>" >&2; exit 1; }
  echo ">>> 上传到 GitHub Release $TAG ..."
  gh release upload "$TAG" --repo "$REPO" --clobber \
    "${BUNDLE_DIR}/macos/${APP_NAME}.app.tar.gz" \
    "${BUNDLE_DIR}/macos/${APP_NAME}.app.tar.gz.sig" \
    "${BUNDLE_DIR}/latest.json" \
    "${BUNDLE_DIR}/dmg/${APP_NAME}_${VERSION}_aarch64.dmg"
  echo ">>> 已上传。latest.json 端点："
  echo "    https://github.com/${REPO}/releases/latest/download/latest.json"
fi
