#!/bin/sh
# エージェントを組み立てて確かめる。
#
# 常駐する2つは Windows でしか動かないので、GOOS=windows で組む。
# 集計と待ち行列（internal/）は OS に依らないので、ここで動かして確かめられる。
#
#   ./build.sh          … 確かめて、dist/ に組む
#   ./build.sh test     … 確かめるだけ
set -eu
cd "$(dirname "$0")"

VERSION="${VERSION:-$(git describe --tags --always 2>/dev/null || echo 0.1.0-dev)}"
LDFLAGS="-s -w -X main.Version=${VERSION}"

echo "== 単体テスト（OSに依らないところ）=="
go test ./internal/...

echo "== Windows 向けの見直し =="
GOOS=windows GOARCH=amd64 go vet ./...

[ "${1:-}" = "test" ] && exit 0

echo "== 組み立て（windows/amd64, ${VERSION}）=="
mkdir -p dist
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -ldflags "${LDFLAGS}" -o dist/eight-agent-svc.exe ./cmd/eight-agent-svc
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -ldflags "${LDFLAGS}" -o dist/eight-agent-ui.exe  ./cmd/eight-agent-ui

echo
echo "できました:"
ls -la dist/
echo
echo "このあと Windows 側でやること:"
echo "  1. 会社の証明書で署名する（signtool）"
echo "  2. SHA256 を取る"
echo "  3. 管理画面の「端末管理 → 設定」に版・URL・SHA256 を登録する"
echo "     3つそろうまで、サーバは「更新なし」を返す（検証できないものを配らないため）"
