#!/bin/sh
# エージェント一式を組み立てる。
#
# 社員が触るのは EIGHT-Agent-Setup.exe の1つだけ。
# 中に、常駐する3つと設定が入っている。
#
#   ふだんは GitHub Actions から組みます（docs/device-release.md）。
#   自分のパソコンに Go を入れる必要はありません。
#   ここを直接叩くのは、手元で試すときだけ。
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

# 拡張の鍵があるなら、それが ID の出どころ。
#
# ID を手で書き写すと、書き間違えても誰も気づかない
# （ブラウザは知らない ID を黙って無視する）。
# 鍵から出せるものを、人が打ち直さない
EXTKEY=""
if [ -n "${EXT_KEY:-}" ]; then
  [ -f "$EXT_KEY" ] || { echo "!! EXT_KEY のファイルがありません: $EXT_KEY"; exit 1; }
  EXTKEY="$(mktemp -d)/extkey"
  go build -o "$EXTKEY" ./cmd/eight-agent-extkey

  from_key="$("$EXTKEY" -key "$EXT_KEY" -json | sed 's/.*"id":"\([^"]*\)".*/\1/')"
  if [ -z "$EXT_ID" ]; then
    EXT_ID="$from_key"
    echo "拡張の ID は鍵から決めました: $EXT_ID"
  elif [ "$EXT_ID" != "$from_key" ]; then
    echo
    echo "!! 拡張の ID が食い違っています。"
    echo "   鍵から出た ID : $from_key"
    echo "   渡された ID   : $EXT_ID"
    echo "   → GitHub Variables の AGENT_EXT_ID を直すか、鍵を取り違えていないか"
    echo "     確かめてください。食い違ったまま配ると、拡張は入りません。"
    echo
    exit 1
  fi
fi

# 形が違うものは、ここで止める。
# 「32文字のChrome拡張ID」のような書き置きが入ったまま配られると、
# EXE はできるのにブラウザ連携だけ黙って入らない
if [ -n "$EXT_ID" ]; then
  case "$EXT_ID" in
    [a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p]\
[a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p]) ;;
    *)
      echo
      echo "!! EXT_ID の形が違います: $EXT_ID"
      echo "   a〜p だけの32文字です（例 lfhomglagbjlpkjmdpdcinkgmbmlmece）。"
      echo "   出し方: go run ./cmd/eight-agent-extkey -key <拡張の秘密鍵>"
      echo
      exit 1 ;;
  esac
fi

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
rm -rf dist/extension
mkdir -p dist/extension
cp extension/manifest.json extension/background.js extension/options.html \
   extension/icon128.png dist/extension/

# 鍵があれば、配る形（.crx と updates.xml）まで作る。
#
# manifest.json に "key" を入れておくと、.crx にしないで
# 「パッケージ化されていない拡張機能を読み込む」で入れたときも同じ ID になる。
# 入ったか確かめるときに要る
if [ -n "$EXTKEY" ]; then
  "$EXTKEY" -key "$EXT_KEY" \
    -stamp dist/extension \
    -pack dist/extension -out dist/eight-ext.crx \
    -updates dist/updates.xml -crx-url "${BASE_URL}/ext/eight-ext.crx" \
    -expect "$EXT_ID"
else
  echo "   （拡張の秘密鍵が無いので .crx は作りません。EXT_KEY を渡すと作ります）"
fi

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
echo "配るまでの手順: docs/device-release.md"
echo
echo "  1. Supabase の Storage → agent バケットに"
echo "     ${VERSION}/EIGHT-Agent-Setup.exe として上げる（バケットは非公開のまま）"
echo "  2. 自前の鍵で署名する:"
echo "       go run ./cmd/eight-agent-keygen -key <秘密鍵> \\"
echo "          -version ${VERSION} -locator ${VERSION}/EIGHT-Agent-Setup.exe \\"
echo "          -file dist/EIGHT-Agent-Setup.exe"
echo "     そのまま流せる insert 文が出る。署名が無い版は published にできない"
echo
echo "  拡張を配るときは、別に:"
echo "    dist/extension/ を .crx に固めて鍵で署名し（拡張の ID が決まる）、"
echo "    その ID を EXT_ID に入れて組み直す。.crx と updates.xml を"
echo "    ${UPDATE_URL} に置く（agent/extension/README.md）"
echo
echo "  ※ 商用のコード署名はしない。会社貸与PCへの導入は管理者・IT担当が行う"
echo "     （SmartScreen の警告を、社員に越えさせないため）"
