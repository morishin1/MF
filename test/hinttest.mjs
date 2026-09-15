import assert from "node:assert/strict";
import { dbSetupHint } from "../lib/http.js";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("  ok", name); };
const F = "db/048_timecard.sql";

ok("実際に出たエラーで発火する", () => {
  // 本番で出たそのままの文言
  const h = dbSetupHint({
    code: "PGRST205",
    message: "Could not find the table 'public.gw_time_entries' in the schema cache",
  }, F);
  assert.ok(h, "hint が出ない");
  assert.match(h, /テーブルがまだ作られていません/);
  assert.match(h, /db\/048_timecard\.sql/);
});

ok("コードが無くても、文言だけで拾う", () => {
  assert.ok(dbSetupHint({ message: "Could not find the table 'public.x' in the schema cache" }, F));
});

ok("Postgres の生エラーでも拾う", () => {
  assert.ok(dbSetupHint({ code: "42P01", message: 'relation "public.gw_time_entries" does not exist' }, F));
});

ok("関係ないエラーでは出さない", () => {
  assert.equal(dbSetupHint({ code: "23505", message: "duplicate key value violates unique constraint" }, F), null);
  assert.equal(dbSetupHint({ code: "42501", message: "new row violates row-level security policy" }, F), null);
  assert.equal(dbSetupHint(null, F), null);
  assert.equal(dbSetupHint({}, F), null);
});

ok("ファイル名はそのまま出る", () => {
  const h = dbSetupHint({ code: "PGRST205", message: "schema cache" }, "db/049_action_triage.sql");
  assert.match(h, /db\/049_action_triage\.sql/);
});

// ---------------------------------------------------------------------------
// ここから先は「その説明が、画面まで届くか」。
//
// サーバがいくら丁寧に書いても、途中で落としたら意味がない。
// 実際に落ちていて、入退社の画面には「not_ready」とだけ出ていた。
// 画面はどこも `e.hint || e.message` の順で出しているので、
// そのどちらかに、人が読める文が入っていること。
console.log("\n— その説明が、画面まで届くか —");

const { readFileSync } = await import("node:fs");

/** api-client.js を、ブラウザのふりをして読み込む */
function loadClient(reply) {
  const win = {};
  const g = {
    window: win,
    localStorage: {
      _v: {},
      getItem(k) { return this._v[k] ?? null; },
      setItem(k, v) { this._v[k] = String(v); },
      removeItem(k) { delete this._v[k]; },
    },
    fetch: async () => reply(),
    console,
    URLSearchParams, URL, Blob, FormData, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, Date, Math, JSON,
  };
  const src = readFileSync(atRoot("js/api-client.js"), "utf8");
  // eslint-disable-next-line no-new-func
  new Function(...Object.keys(g), src)(...Object.values(g));
  // ログイン済みということにする（api() は token が無いと手前で止まる）
  g.localStorage.setItem("kp_session", JSON.stringify({
    access_token: "x", email: "zimu@8grp.co.jp",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  return win.API;
}

const res503 = (body) => ({
  ok: false, status: 503,
  json: async () => body,
});

const caught = async (fn) => {
  try { await fn(); } catch (e) { return e; }
  throw new Error("エラーにならなかった");
};

await (async () => {
  const hint = dbSetupHint({
    code: "PGRST205",
    message: "Could not find the table 'public.gw_procedures' in the schema cache",
  }, "db/008_onboarding.sql → 066_hr_flow.sql");

  const API = loadClient(() => res503({ error: "not_ready", message: hint }));
  const e = await caught(() => API.hrList());

  ok("表がまだ無いとき、やることが画面に届く", () => {
    // 画面は e.hint → e.message の順に見る。どちらでも文になっていること
    assert.match(e.hint || "", /066_hr_flow\.sql/, `hint: ${e.hint}`);
    assert.match(e.message || "", /テーブルがまだ作られていません/, `message: ${e.message}`);
  });

  ok("コード名だけを画面に出さない", () => {
    // ここが落ちていた。画面に「not_ready」とだけ出ていた
    assert.notEqual(e.message, "not_ready");
    assert.notEqual(e.hint, "not_ready");
  });

  ok("コード名は、機械が読むほうに残す", () => {
    // 画面が「この種類のときだけ別の出し方をする」ために要る
    assert.equal(e.code, "not_ready");
    assert.equal(e.status, 503);
    assert.equal(e.body.error, "not_ready");
  });
})();

await (async () => {
  // hint があるときは、そちらが優先（detail は原因の生の文言なので出さない）
  const API = loadClient(() => res503({
    error: "onboard_failed", hint: "入社手続きの用意に失敗しました", detail: "column x does not exist",
  }));
  const e = await caught(() => API.hrList());
  ok("hint があれば、それを出す", () => {
    assert.equal(e.hint, "入社手続きの用意に失敗しました");
    assert.equal(e.message, "入社手続きの用意に失敗しました");
    assert.equal(e.code, "onboard_failed");
    assert.equal(e.detail, "column x does not exist");
  });
})();

await (async () => {
  // 説明が何も無いときだけ、コード名に落ちる（何も出ないよりはまし）
  const API = loadClient(() => res503({ error: "forbidden" }));
  const e = await caught(() => API.hrList());
  ok("説明が無ければ、コード名に落ちる", () => {
    assert.equal(e.message, "forbidden");
    assert.equal(e.code, "forbidden");
    assert.equal(e.hint, null);
  });
})();

console.log(`\n${n} 件 すべて通りました`);
