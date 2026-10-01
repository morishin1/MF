// 入社案内の純粋な部品（lib/onboard-guide.js）。
//
// ■ 何を守るのか
//   1. 経営者が書く項目だけを受ける。知らないキー・文字以外・長すぎる値は、決めたとおりに扱う
//   2. 金額らしい表記は、案内に書かせない（給与・手当・費用は、労働条件通知書で伝える）
//   3. 本人に返すのは、許した項目だけ（社内メモや別の項目は、返らない）
//   4. 発行した確定版は、名簿の値＋下書き。AI・推測で日付や条件を作らない
//   5. 案内メールは、確定した値だけで作る。パスワードを書かない。期限つきのURLを使う
import assert from "node:assert/strict";
import {
  GUIDE_FIELDS, GUIDE_KEYS, findMoneyMention, normalizeGuideInput, buildSnapshot, guideView,
  missingFields, guideFact, inviteExpiry, publicBaseUrl, inviteUrl, renderInviteMail,
  INVITE_TTL_DAYS_DEFAULT, INVITE_TTL_DAYS_MAX,
} from "../lib/onboard-guide.js";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

console.log("— 入力 —");

ok("書ける項目は8つ。名簿から写す項目（氏名・入社日など）は含まない", () => {
  assert.deepEqual(GUIDE_KEYS, ["meeting_time", "start_time", "location", "schedule", "belongings", "contact", "staff", "message"]);
});

ok("知らないキーは捨てる（employee_id・version・issued_at などを、下書きから書き換えさせない）", () => {
  const r = normalizeGuideInput({ location: "原宿", version: 99, employee_id: "x", confirmed_at: "2026-01-01", tenant_id: "t" });
  assert.deepEqual(r.value, { location: "原宿" });
});

ok("空文字は null（消す）。空白だけも null。渡されなかったキーは触らない", () => {
  const r = normalizeGuideInput({ location: "  ", staff: "" });
  assert.deepEqual(r.value, { location: null, staff: null });
  assert.ok(!("message" in r.value));
});

ok("文字以外は断る（配列・数値・オブジェクト）", () => {
  for (const bad of [["a"], 10, { a: 1 }, true]) {
    const r = normalizeGuideInput({ location: bad });
    assert.equal(r.error, "invalid_body");
    assert.equal(r.field, "location");
  }
});

ok("長すぎる値は、決めた長さで切る。制御文字は除く。複数行の項目だけ改行を残す", () => {
  const r = normalizeGuideInput({ location: "a".repeat(500), schedule: "1行目\r\n2行目\u0000\n\n3行目", meeting_time: "9:45\n10:00" });
  assert.equal(r.value.location.length, 200);
  assert.equal(r.value.schedule, "1行目\n2行目\n\n3行目");
  assert.equal(r.value.meeting_time, "9:4510:00", "1行の項目は改行を除く");
});

ok("null・body が無くても落ちない", () => {
  assert.deepEqual(normalizeGuideInput(null).value, {});
  assert.deepEqual(normalizeGuideInput(undefined).value, {});
});

console.log("— 金額は書けない —");

ok("金額らしい表記は見つける（円・万円・¥・給与を表す語＋万）", () => {
  for (const t of ["交通費は1,000円まで", "月給30万", "基本給 300000円", "¥5000", "￥5,000", "時給 1500円", "手当は月2万", "支度金 10万円"]) {
    assert.ok(findMoneyMention(t), t);
  }
});

ok("時刻・日付・人数・番号は、金額として扱わない", () => {
  for (const t of ["9:45に集合", "10月1日", "3階の受付", "03-1234-5678", "持ち物：印鑑・筆記用具", "10名の新入社員", "8万人規模の展示会に参加", "経費精算の説明があります"]) {
    assert.equal(findMoneyMention(t), null, t);
  }
});

ok("金額を含む項目は、保存を断る（どの項目かと理由を返す）", () => {
  const r = normalizeGuideInput({ message: "月給30万円からのスタートです" });
  assert.equal(r.error, "money_in_guide");
  assert.equal(r.field, "message");
  assert.match(r.hint, /労働条件通知書/);
  assert.equal(r.value, undefined);
});

console.log("— 確定版・本人に見せる形 —");

const EMP = { display_name: "山田 太郎", joined_on: "2026-10-15", department: "開発", position: "エンジニア", initial_role: "バックエンド",
  wage_amount: 999999, email: "y@example.com", manager_id: "m1" };

ok("確定版は、名簿の値＋下書き。入社日は手続きの入社予定日を優先。名簿の給与・メールは入れない", () => {
  const s = buildSnapshot({ employee: EMP, procedure: { target_on: "2026-10-01" }, draft: { location: "原宿", message: null, junk: "x", id: "g" } });
  assert.equal(s.name, "山田 太郎");
  assert.equal(s.joinOn, "2026-10-01");
  assert.equal(s.department, "開発");
  assert.equal(s.role, "バックエンド");
  assert.equal(s.location, "原宿");
  assert.equal(s.message, null);
  const text = JSON.stringify(s);
  for (const leaked of ["999999", "wage", "y@example.com", "manager", "junk", '"id"']) assert.ok(!text.includes(leaked), leaked);
  assert.equal(buildSnapshot({ employee: EMP, procedure: null, draft: {} }).joinOn, "2026-10-15", "手続きが無ければ名簿の入社日");
  assert.equal(buildSnapshot({ employee: { display_name: "A" }, draft: {} }).joinOn, null, "日付を作らない");
});

ok("本人に返すのは、許した項目だけ（余計なキーは返らない）", () => {
  const v = guideView({ name: "山田", location: "原宿", internal_note: "社内メモ", wage_amount: 1, token: "t" });
  assert.equal(v.name, "山田");
  assert.equal(v.location, "原宿");
  assert.ok(!("internal_note" in v) && !("wage_amount" in v) && !("token" in v));
  assert.equal(v.message, null);
});

ok("発行前に足りないものを教える（集合時間・勤務場所・当日の連絡先・入社日）", () => {
  assert.deepEqual(missingFields({}, { joinOn: null }), ["初日の集合時間", "勤務場所", "当日の連絡先", "入社日（入社手続きの入社予定日）"]);
  assert.deepEqual(missingFields({ meeting_time: "9:45", location: "x", contact: "y" }, { joinOn: "2026-10-01" }), []);
});

ok("6ステップに渡す事実: 版が0なら下書き、1以上なら発行済み。確認した版を持つ", () => {
  assert.equal(guideFact(null), null);
  assert.deepEqual(guideFact({ version: 0 }), { status: "draft", version: 0, confirmedVersion: null, confirmedAt: null });
  assert.deepEqual(guideFact({ version: 2, confirmed_version: 1, confirmed_at: "2026-09-20T00:00:00Z" }),
    { status: "issued", version: 2, confirmedVersion: 1, confirmedAt: "2026-09-20T00:00:00Z" });
});

console.log("— 案内URL —");

ok("有効期限は既定7日。1〜30日に収める。数でない値は既定", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  assert.equal(inviteExpiry(undefined, now), "2026-10-08T00:00:00.000Z");
  assert.equal(inviteExpiry(3, now), "2026-10-04T00:00:00.000Z");
  assert.equal(inviteExpiry(999, now), new Date(now + INVITE_TTL_DAYS_MAX * 86400000).toISOString());
  assert.equal(inviteExpiry(0, now), new Date(now + INVITE_TTL_DAYS_DEFAULT * 86400000).toISOString());
  assert.equal(inviteExpiry("abc", now), new Date(now + INVITE_TTL_DAYS_DEFAULT * 86400000).toISOString());
});

ok("URLの基準は PUBLIC_BASE_URL → 開いているホスト → VERCEL_URL。ホストの偽装は受けない", () => {
  assert.equal(publicBaseUrl({ headers: {} }, { PUBLIC_BASE_URL: "https://gw.example.com/" }), "https://gw.example.com");
  assert.equal(publicBaseUrl({ headers: { host: "gw.example.com" } }, {}), "https://gw.example.com");
  assert.equal(publicBaseUrl({ headers: { "x-forwarded-host": "a.example.com, b.example.com" } }, {}), "https://a.example.com");
  assert.equal(publicBaseUrl({ headers: { host: "localhost:3000" } }, {}), "http://localhost:3000");
  assert.equal(publicBaseUrl({ headers: { host: 'evil.com/"><script>' } }, { VERCEL_URL: "x.vercel.app" }), "https://x.vercel.app");
  assert.equal(publicBaseUrl({ headers: {} }, {}), "https://mf.8grp.co.jp");
  assert.equal(inviteUrl("https://gw.example.com/", "a-b_c"), "https://gw.example.com/onboarding/?t=a-b_c");
});

console.log("— 案内メールの文面 —");

const MAIL = { companyName: "株式会社エイト", name: "山田 太郎", joinOn: "2026-10-01",
  url: "https://gw.example.com/onboarding/?t=TOKEN", expiresAt: "2026-10-08T00:00:00.000Z", senderName: "人事 森田" };

ok("件名・宛名・入社日・URL・期限・差出人。「入社準備のページ」を中心にする", () => {
  const m = renderInviteMail(MAIL);
  assert.equal(m.subject, "【株式会社エイト】ご入社にあたってのご案内");
  assert.match(m.text, /^山田 太郎 様/);
  assert.match(m.text, /10月1日のご入社に向けて/);
  assert.match(m.text, /https:\/\/gw\.example\.com\/onboarding\/\?t=TOKEN/);
  assert.match(m.text, /2026年10月8日 09:00 まで有効/, "JST に直す");
  assert.match(m.text, /人事 森田$/);
});

ok("パスワードを書かない。金額を書かない。日付を作らない", () => {
  const m = renderInviteMail({ ...MAIL, joinOn: null });
  assert.match(m.text, /ログイン情報（ID・パスワード）は、このメールには書いていません/);
  assert.ok(!/[0-9][0-9,]*円|給与|手当|password=|パスワードは/.test(m.text.replace("パスワード）は、このメールには書いていません", "")), m.text);
  assert.match(m.text, /^山田 太郎 様\n\nご入社に向けて、/, "入社日が無ければ、入社日を書かない");
});

ok("会社名・差出人が無くても文面が崩れない", () => {
  const m = renderInviteMail({ name: "A", url: "https://x/y", expiresAt: "bad" });
  assert.match(m.subject, /株式会社エイト/);
  assert.match(m.text, /有効期限があります/);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
