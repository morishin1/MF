#!/bin/sh
# エージェント一式を組み立てる。
#
# 社員が触るのは EIGHT-Agent-Setup.exe の1つだけ。
# 中に、常駐する3つと設定が入っている。
#
#   ./build.sh          … 確かめて、dist/ に組む
#   ./build.sh test     … 確かめるだけ
#
# 拡張のID（EXT_ID）を入れずに組むと、インストーラはブラウザ連携を
# 設定できずに止まる。組む前に agent/extension/README.md を読むこと。
set -eu
cd "$(dirname "$0")"

VERSION="${VERSION:-$(git describe --tags --always 2>/dev/null || echo 0.2.0-dev)}"
BASE_URL="${BASE_URL:-https://mf.8grp.co.jp}"
EXT_ID="${EXT_ID:-}"
UPDATE_URL="${UPDATE_URL:-${BASE_URL}/ext/updates.xml}"

echo "== 単体テスト（OSに依らないところ）=="
go test ./internal/...

echo "== Windows 向けの見直し =="
GOOS=windows GOARCH=amd64 go vet ./...

[ "${1:-}" = "test" ] && exit 0

if [ -z "$EXT_ID" ]; then
  echo
  echo "!! EXT_ID が空です。"
  echo "   このまま組むと、インストーラはブラウザ連携を設定できずに止まります。"
  echo "   拡張の鍵から ID を出して、EXT_ID=... を付けて組み直してください。"
  echo "   手順: agent/extension/README.md"
  echo
fi

LD="-s -w -X main.Version=${VERSION}"

echo "== 常駐する3つ（windows/amd64, ${VERSION}）=="
mkdir -p dist cmd/eight-agent-setup/payload
for t in svc ui host; do
  GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
    go build -trimpath -ldflags "${LD}" \
    -o "cmd/eight-agent-setup/payload/eight-agent-${t}.exe" "./cmd/eight-agent-${t}"
  cp "cmd/eight-agent-setup/payload/eight-agent-${t}.exe" dist/
done

echo "== インストーラ（この1つだけを配る）=="
# -H windowsgui … 黒い窓を出さない。社員が「コマンドの画面が出た」と驚かないため
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath \
  -ldflags "${LD} -H windowsgui \
    -X main.BaseURL=${BASE_URL} \
    -X main.ExtensionID=${EXT_ID} \
    -X main.UpdateURL=${UPDATE_URL}" \
  -o dist/EIGHT-Agent-Setup.exe ./cmd/eight-agent-setup

echo "== 拡張 =="
mkdir -p dist/extension
cp extension/manifest.json extension/background.js extension/options.html dist/extension/
[ -f extension/icon128.png ] && cp extension/icon128.png dist/extension/ || \
  echo "   （icon128.png がありません。配る前に置いてください）"

echo
echo "できました:"
ls -la dist/
echo
echo "このあと Windows 側でやること:"
echo "  1. dist/extension/ を .crx に固めて、鍵で署名する（ID が決まる）"
echo "  2. その ID を EXT_ID に入れて、この build.sh を組み直す"
echo "  3. .crx と updates.xml を ${UPDATE_URL} に置く"
echo "  4. 会社の証明書で EIGHT-Agent-Setup.exe に署名する（signtool）"
echo "     署名しないと SmartScreen が止めます。社員に警告を無視させないこと"
echo "  5. SHA256 を取って、管理画面の「端末管理 → 設定」に版・URL・SHA256 を登録する"
echo "     3つそろうまで、サーバは「更新なし」を返す（検証できないものを配らないため）"
