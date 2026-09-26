// 招待URLを開いたときの確認・登録（api/guests/accept.js）を、偽のSupabaseで通す。
// ここだけはログイン前提ではない、唯一の外部メンバー向けAPI。
//
// ■ 何を守るテストか
//
//   1. 有効なトークンなら、氏名・会社名・テナント名が見える
//   2. 存在しない・期限切れ・使用済み・無効化されたトークンは、同じ答えを返す
//      （どれが理由かは漏らさない）
//   3. 登録すると、ログインアカウント（auth.users）ができ、
//      gw_guests.user_id が埋まり、招待は使用済みになる
//   4. 同時に2回押しても、片方しか通らない（早い者勝ち）
//   5. パスワードは8文字未満なら拒否
//   6. 登録すると監査ログに guest.register が残る
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);
const { sha256 } = await import(atRoot("lib/guests.js"));

// ---- 偽の Supabase --------------------------------------------------------
const db = { rows: {} };
const logged = [];
let createUserCalls = 0;
let failCreateUser = false;

function table(name) {
  const f = [];
  const rows = () => (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => {
    if (op === "eq") return r[k] === v;
    return true;
  }));
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]), error: null }),
    update(patch) {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push(["eq", k, v]); return r2; },
        is: (k, v) => { g.push(["is", k, v]); return r2; },
        select: () => r2,
        then: (fn) => {
          const hit = (db.rows[name] || []).filter((x) => g.every(([op, k, v]) => {
            if (op === "eq") return x[k] === v;
            if (op === "is") return v === null ? x[k] == null : x[k] === v;
            return true;
          }));
          for (const x of hit) Object.assign(x, patch);
          return Promise.resolve({ data: hit.map(copy), error: null }).then(fn);
        },
      };
      return r2;
    },
  };
  return q;
}
const copy = (r) => (r ? { ...r } : null);

const sbAdmin = {
  from: table,
  auth: {
    admin: {
      createUser: async ({ email }) => {
        createUserCalls++;
        if (failCreateUser) return { data: null, error: { message: "boom" } };
        return { data: { user: { id: `auth-${email}` } }, error: null };
      },
    },
  },
};

mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => sbAdmin, userClient: () => sbAdmin } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });

const { default: accept } = await import(atRoot("api/guests/accept.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const preview = (token) => {
  const r = res();
  return accept({ method: "GET", url: `/api/guests/accept?token=${encodeURIComponent(token || "")}`, headers: {} }, r).then(() => r);
};
const register = (token, password) => {
  const r = res();
  return accept({ method: "POST", url: "/api/guests/accept", headers: {}, body: { token, password } }, r).then(() => r);
};

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const TOKEN = "a".repeat(43); // base64url風の長さ
function setup() {
  createUserCalls = 0; failCreateUser = false; logged.length = 0;
  db.rows = {
    tenants: [{ id: "t1", name: "株式会社エイト" }],
    gw_guests: [{ id: "g1", tenant_id: "t1", display_name: "社外 太郎", company_name: "サンプル社",
      email: "taro@example.com", user_id: null, disabled_at: null }],
    gw_guest_invites: [{ id: "iv1", tenant_id: "t1", guest_id: "g1", token_hash: sha256(TOKEN),
      expires_at: new Date(Date.now() + 86400000).toISOString(), used_at: null, revoked_at: null }],
  };
}

console.log("\n=== 招待の受け取り・登録（api/guests/accept.js） ===\n");

console.log("— 確認（GET） —");

await ok("有効なトークンなら、氏名・会社名・テナント名が見える", async () => {
  setup();
  const r = await preview(TOKEN);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.displayName, "社外 太郎");
  assert.equal(r.body.tenantName, "株式会社エイト");
});

await ok("存在しないトークンは404", async () => {
  setup();
  const r = await preview("x".repeat(40));
  assert.equal(r.statusCode, 404);
});

await ok("期限切れは404（存在しないのと同じ答え）", async () => {
  setup();
  db.rows.gw_guest_invites[0].expires_at = new Date(Date.now() - 1000).toISOString();
  const r = await preview(TOKEN);
  assert.equal(r.statusCode, 404);
});

await ok("使用済みは404", async () => {
  setup();
  db.rows.gw_guest_invites[0].used_at = new Date().toISOString();
  const r = await preview(TOKEN);
  assert.equal(r.statusCode, 404);
});

await ok("無効化された招待は404", async () => {
  setup();
  db.rows.gw_guest_invites[0].revoked_at = new Date().toISOString();
  const r = await preview(TOKEN);
  assert.equal(r.statusCode, 404);
});

await ok("形がおかしいトークンも404（DBを引かない）", async () => {
  setup();
  const r = await preview("短い");
  assert.equal(r.statusCode, 404);
});

console.log("— 登録（POST） —");

await ok("パスワードが8文字未満なら拒否", async () => {
  setup();
  const r = await register(TOKEN, "short");
  assert.equal(r.statusCode, 400);
  assert.equal(createUserCalls, 0);
});

await ok("登録すると、ログインアカウントができ、ゲストに紐づく", async () => {
  setup();
  const r = await register(TOKEN, "password123");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.email, "taro@example.com");
  assert.equal(createUserCalls, 1);
  assert.equal(db.rows.gw_guests[0].user_id, "auth-taro@example.com");
  assert.ok(db.rows.gw_guest_invites[0].used_at, "招待は使用済みになる");
});

await ok("監査ログに guest.register が残る", async () => {
  setup();
  await register(TOKEN, "password123");
  assert.ok(logged.some((l) => l.action === "guest.register"));
});

await ok("同時に2回押しても、片方しか通らない", async () => {
  setup();
  const [r1, r2] = await Promise.all([register(TOKEN, "password123"), register(TOKEN, "password123")]);
  const okCount = [r1, r2].filter((r) => r.statusCode === 200).length;
  assert.equal(okCount, 1, "1回しか成立しない");
  assert.equal(createUserCalls, 1, "アカウント作成も1回だけ");
});

await ok("アカウント作成に失敗したら、招待は使い直せるよう巻き戻す", async () => {
  setup();
  failCreateUser = true;
  const r = await register(TOKEN, "password123");
  assert.equal(r.statusCode, 500);
  assert.equal(db.rows.gw_guest_invites[0].used_at, null, "使用済みに固定されない");
});

await ok("登録済みのゲストのトークンでは、もう受け付けない", async () => {
  setup();
  db.rows.gw_guests[0].user_id = "already-there";
  const r = await register(TOKEN, "password123");
  assert.equal(r.statusCode, 404);
});

await ok("無効化されたゲストのトークンでは受け付けない", async () => {
  setup();
  db.rows.gw_guests[0].disabled_at = new Date().toISOString();
  const r = await register(TOKEN, "password123");
  assert.equal(r.statusCode, 404);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
