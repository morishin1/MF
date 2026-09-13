#!/bin/sh
# エージェント一式を組み立てる。
#
# 社員が触るのは EIGHT-Agent-Setup.exe の1つだけ。
# 中に、常駐する3つと設定が入っている。
#
#   ./build.sh          … 確かめて、dist/ に組む
#   ./build.sh test     … 確かめるだけ
#
# ■ 費用のかかるものは使わない
#
#   商用のコード署名証明書は買わない。MDM も要らない。
#   1台ごとの利用料もない。社内PCへ配るだけなので、これでよいと決めた。
#
#   そのぶん、初回は Windows の警告（SmartScreen）が出る。
#   初回だけは管理者か社内IT担当が、対象PCで実行する運用にしてある。
#   → docs/device-zero-cost.md
#
#   証明書は「必須」ではなく「将来必要になれば足せる」。
#   署名が無いことを理由に、ここで組み立てを止めることはしない。
#
# ■ そのかわり、更新は自前の鍵で確かめる
#
#   UPDATE_KEY に公開鍵を入れて組むと、その鍵で署名した版しか
#   エージェントは実行しない。鍵は下で作る:
#
#     go run ./cmd/eight-agent-keygen -new -out ~/eight-update.key
#
#   UPDATE_KEY が空だと、エージェントは自動更新を一切しない
#   （確かめられないものを実行するくらいなら、古い版のままでいる）。
set -eu
cd "$(dirname "$0")"

VERSION="${VERSION:-$(git describe --tags --always 2>/dev/null || echo 0.2.0-dev)}"
BASE_URL="${BASE_URL:-https://mf.8grp.co.jp}"
EXT_ID="${EXT_ID:-}"
UPDATE_URL="${UPDATE_URL:-${BASE_URL}/ext/updates.xml}"
UPDATE_KEY="${UPDATE_KEY:-}"

echo "== 単体テスト（OSに依らないところ）=="
go test ./internal/...

echo "== Windows 向けの見直し =="
GOOS=windows GOARCH=amd64 go vet ./...

[ "${1:-}" = "test" ] && exit 0

if [ -z "$EXT_ID" ]; then
  echo
  echo "!! EXT_ID が空です。"
  echo "   PC側の記録（起動終了・ソフト・USB・離席）は動きますが、"
  echo "   ブラウザ連携（WEB利用）は設定されません。"
  echo "   拡張の鍵から ID を出して組み直してください: agent/extension/README.md"
  echo
fi

if [ -z "$UPDATE_KEY" ]; then
  echo
  echo "!! UPDATE_KEY が空です。"
  echo "   このまま組むと、エージェントは自動更新をしません（手で配ることになります）。"
  echo "   鍵の作り方: go run ./cmd/eight-agent-keygen -new -out ~/eight-update.key"
  echo
fi

LD="-s -w -X main.Version=${VERSION}"

echo "== 常駐する3つ（windows/amd64, ${VERSION}）=="
mkdir -p dist cmd/eight-agent-setup/payload
for t in svc ui host; do
  # 公開鍵は svc にだけ要る（更新を確かめるのは svc）。
  # 他に焼いても害はないが、入れる場所は1つにしておく
  extra=""
  [ "$t" = "svc" ] && extra="-X main.UpdateKey=${UPDATE_KEY}"
  GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
    go build -trimpath -ldflags "${LD} ${extra}" \
    -o "cmd/eight-agent-setup/payload/eight-agent-${t}.exe" "./cmd/eight-agent-${t}"
  cp "cmd/eight-agent-setup/payload/eight-agent-${t}.exe" dist/
done

echo "== インストーラ（この1つだけを配る）=="
# -H windowsgui … 黒い窓を出さない。「コマンドの画面が出た」と驚かせないため
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

# 秘密鍵の場所が渡されていれば、その場で署名まで済ませる。
# 渡されていなければ、下の手順で手で署名する
if [ -n "${RELEASE_KEY:-}" ] && [ -n "${RELEASE_URL:-}" ]; then
  echo
  echo "== リリース署名 =="
  go run ./cmd/eight-agent-keygen \
    -key "${RELEASE_KEY}" \
    -version "${VERSION}" \
    -url "${RELEASE_URL}" \
    -file dist/EIGHT-Agent-Setup.exe
fi

echo
echo "できました:"
ls -la dist/
echo
echo "このあと Windows 側でやること:"
echo "  1. dist/extension/ を .crx に固めて、鍵で署名する（拡張の ID が決まる）"
echo "  2. その ID を EXT_ID に入れて、この build.sh を組み直す"
echo "  3. .crx と updates.xml を ${UPDATE_URL} に置く"
echo "  4. EIGHT-Agent-Setup.exe を社内の置き場に上げる"
echo "     ※ 商用のコード署名はしない。初回は管理者が対象PCで実行する"
echo "        （SmartScreen の警告が出るので、社員に判断させない）"
echo "  5. 更新として配るなら、自前の鍵で署名する:"
echo "       go run ./cmd/eight-agent-keygen -key <秘密鍵> \\"
echo "          -version ${VERSION} -url <配布URL> -file dist/EIGHT-Agent-Setup.exe"
echo "     出てきた 版・URL・SHA256・大きさ・署名・鍵の目印 を"
echo "     Supabase の gw_device_releases に入れる（SQLは docs/device-zero-cost.md）"
echo "     署名が無い版は published にできない（DBの制約で止まる）"
