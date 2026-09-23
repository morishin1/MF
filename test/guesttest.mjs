// 外部メンバー招待の値の定義・状態判定。純粋関数だけを見る。
//
// ■ 何を守るテストか
//
//   1. 状態は「無効化」「登録済み」「招待の期限切れ」「まだ招待中」の順で決まる
//      （無効化がいちばん強い。登録済みでも無効化されていれば「無効」）
//   2. トークンは英数字とハイフン系だけの決まった長さ
//   3. 新規招待・許可の入力チェック
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const G = await import(join(ROOT, "lib/guests.js"));

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

console.log("\n=== 外部メンバー招待（純粋関数） ===\n");

console.log("— トークン —");

ok("トークンは決まった文字種・長さ", () => {
  const t = G.newInviteToken();
  assert.match(t, G.TOKEN_RE);
  assert.ok(t.length >= 32);
});
ok("同じ文字列は同じハッシュになる（比較に使うため）", () => {
  assert.equal(G.sha256("abc"), G.sha256("abc"));
  assert.notEqual(G.sha256("abc"), G.sha256("abd"));
});
ok("平文はハッシュから戻せない（見た目のチェックだけ）", () => {
  const t = G.newInviteToken();
  assert.notEqual(G.sha256(t), t);
});

console.log("— 状態の判定 —");

const guest = (over = {}) => ({ id: "g1", user_id: null, disabled_at: null, ...over });
const invite = (over = {}) => ({ expires_at: new Date(Date.now() + 86400000).toISOString(),
  used_at: null, revoked_at: null, ...over });

ok("招待したて：招待済み", () => {
  assert.equal(G.guestStatus(guest(), invite()), "invited");
});
ok("登録すると：登録完了", () => {
  assert.equal(G.guestStatus(guest({ user_id: "u1" }), invite()), "active");
});
ok("期限が過ぎた招待：期限切れ", () => {
  assert.equal(G.guestStatus(guest(), invite({ expires_at: new Date(Date.now() - 1000).toISOString() })), "expired");
});
ok("招待を取り消した：無効", () => {
  assert.equal(G.guestStatus(guest(), invite({ revoked_at: new Date().toISOString() })), "revoked");
});
ok("無効化は、登録済みより強い", () => {
  assert.equal(G.guestStatus(guest({ user_id: "u1", disabled_at: new Date().toISOString() }), invite()), "revoked");
});
ok("招待の行がまだ無い（直後の一瞬）：招待済み扱い", () => {
  assert.equal(G.guestStatus(guest(), null), "invited");
});

console.log("— 新規招待の入力チェック —");

ok("氏名・メールがそろえば通る", () => {
  const r = G.normalizeGuest({ displayName: "社外 太郎", email: "taro@example.com", companyName: "サンプル社" });
  assert.equal(r.error, undefined);
  assert.equal(r.value.display_name, "社外 太郎");
  assert.equal(r.value.email, "taro@example.com");
});
ok("メールは小文字にそろえる", () => {
  const r = G.normalizeGuest({ displayName: "A", email: "Taro@Example.COM" });
  assert.equal(r.value.email, "taro@example.com");
});
ok("氏名が空なら拒否", () => {
  const r = G.normalizeGuest({ displayName: "  ", email: "a@b.com" });
  assert.ok(r.error);
});
ok("メールの形が違えば拒否", () => {
  const r = G.normalizeGuest({ displayName: "A", email: "not-an-email" });
  assert.ok(r.error);
});
ok("会社名は無くてもよい", () => {
  const r = G.normalizeGuest({ displayName: "A", email: "a@b.com" });
  assert.equal(r.error, undefined);
  assert.equal(r.value.company_name, null);
});

console.log("— 許可の入力チェック —");

ok("決まった4種類だけ通る", () => {
  for (const t of ["project", "thread", "document", "task"]) {
    const r = G.normalizeGrant({ resourceType: t, resourceKey: "x" });
    assert.equal(r.error, undefined, t);
  }
  const bad = G.normalizeGrant({ resourceType: "employee", resourceKey: "x" });
  assert.ok(bad.error);
});
ok("resourceKey が空なら拒否", () => {
  const r = G.normalizeGrant({ resourceType: "task", resourceKey: "" });
  assert.ok(r.error);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
