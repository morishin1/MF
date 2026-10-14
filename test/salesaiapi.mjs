// AI営業の API（api/sales/ai/*）と、アタック（api/sales/approaches）への連携を、偽の DB・偽の AI・偽のサイトで通す。
//
// ■ 何を守るテストか
//   1. 使えるのは Sales を使える人だけ（経営者・Sales のアプリ権限）。他テナントの行は見えない・触れない
//   2. 分析：止まっている・キーが無い・表が無いときは AI を呼ばない。NG・直近30日・サイトなし・robots は AI を呼ばずに外す。
//      営業お断りの記載は AI の答えに関係なく「送信不可」。予算の予約を断られたら AI を呼ばない。AI の失敗は台帳に残る
//   3. 営業文：分析の無い・送信不可の会社には作らない。承認は経営者・営業責任者（manager＋Salesアプリ）だけ。
//      作った人・直した人・依頼した人は承認できない。差し戻しは理由が必須。直したら承認をやり直す
//   4. 送る：AI で「送信不可」の会社は専用URLも出さない。「要確認」のままではフォームで送信完了にできない。
//      承認済みの AI 文面で送ると、サーバが最終文面（差し込み＋署名）を作り直して残し、営業文を「使用済み」にする。
//      承認後に書き換わった営業文では送れない
//   5. 管理：開始・停止・設定は経営者・管理者だけ。月の上限は 100 ドルまで
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createMemDb } from "./_memdb.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const at = (p) => join(ROOT, p);

const T1 = "11111111-1111-4111-8111-111111111111", T2 = "22222222-2222-4222-8222-222222222222";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const C1 = id(101), C_NG = id(102), C_RECENT = id(103), C_NOSITE = id(104), C_BLOCK = id(105), C_ROBOTS = id(106), C9 = id(109), C_FAIL = id(107);
const nowIso = () => new Date().toISOString();

const ACTIVE = ["approved", "used"];
const schema = {
  gw_sales_ai_drafts: {
    defaults: () => ({ status: "draft", version: 1, created_at: nowIso(), updated_at: nowIso() }),
    // db/131 の CHECK と同じ
    check: (r) => (ACTIVE.includes(r.status) && (!r.decided_by || r.decided_by === r.created_by || r.decided_by === r.requested_by)
      ? "gw_sales_ai_drafts_no_self_approval"
      : ACTIVE.includes(r.status) && !r.approved_body_hash ? "gw_sales_ai_drafts_approved_hash" : null),
  },
  gw_sales_ai_analyses: { defaults: () => ({ created_at: nowIso(), facts: [], hypotheses: [], uncertainties: [], send_check_reasons: [], pages: [], effective: false }) },
  // db/131：company_id が主キー（1社1行。分類し直すと上書き）
  gw_sales_ai_classifications: { noId: true, unique: [["company_id"]] },
  gw_sales_ai_usage: { defaults: () => ({ created_at: nowIso(), status: "reserved", reserved_usd: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0 }) },
  gw_sales_ai_settings: { noId: true, unique: [["tenant_id"]], defaults: () => ({ enabled: false, monthly_target_usd: 50, monthly_cap_usd: 100, daily_cap_usd: 10, daily_company_limit: 100, effective_threshold: 60, focus_services: [], score_profiles: {}, banned_phrases: [] }) },
  gw_sales_approaches: { defaults: () => ({ prepared_at: nowIso(), created_at: nowIso(), click_count: 0, channel: "form", forced: false }) },
};
const mem = createMemDb({ schema });

// ---- 予算の関数（db/131 gw_sales_ai_reserve / gw_sales_ai_settle と同じ判定。並列・日付の境目は test/sql/131 が本物で見る）
const ctl = { reserveFail: null, rpcCalls: [] };
const spent = (tenant) => (mem.rows.gw_sales_ai_usage || []).filter((u) => u.tenant_id === tenant && u.status !== "released")
  .reduce((n, u) => n + Number(u.status === "committed" ? u.cost_usd : u.reserved_usd), 0);
function rpc(name, a) {
  ctl.rpcCalls.push(name);
  if (name === "gw_sales_ai_reserve") {
    if (ctl.reserveFail) return { data: [{ reservation_id: null, reason: ctl.reserveFail }], error: null };
    const s = (mem.rows.gw_sales_ai_settings || []).find((x) => x.tenant_id === a.p_tenant);
    if (!s?.enabled) return { data: [{ reservation_id: null, reason: s?.paused_reason ? `paused:${s.paused_reason}` : "disabled" }], error: null };
    if (spent(a.p_tenant) + a.p_estimate > Number(s.monthly_cap_usd)) return { data: [{ reservation_id: null, reason: "monthly_cap" }], error: null };
    const row = { id: crypto.randomUUID(), tenant_id: a.p_tenant, company_id: a.p_company, employee_id: a.p_employee, purpose: a.p_purpose,
      model: a.p_model, status: "reserved", reserved_usd: a.p_estimate, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: nowIso() };
    (mem.rows.gw_sales_ai_usage ||= []).push(row);
    return { data: [{ reservation_id: row.id, reason: null }], error: null };
  }
  if (name === "gw_sales_ai_settle") {
    const u = (mem.rows.gw_sales_ai_usage || []).find((x) => x.id === a.p_id);
    Object.assign(u, { status: "committed", input_tokens: a.p_input, output_tokens: a.p_output, cost_usd: a.p_cost, outcome: a.p_outcome, error_code: a.p_error, latency_ms: a.p_latency });
    const s = mem.rows.gw_sales_ai_settings.find((x) => x.tenant_id === u.tenant_id);
    if (spent(u.tenant_id) >= Number(s.monthly_cap_usd)) { s.enabled = false; s.paused_reason = "monthly_cap"; return { data: "monthly_cap", error: null }; }
    return { data: null, error: null };
  }
  return { data: null, error: { code: "PGRST202", message: `Could not find the function ${name}` } };
}
const client = () => ({ ...mem.admin(), from: (n) => mem.admin().from(n), rpc: async (n, a) => rpc(n, a) });
// アタック（api/sales/approaches）は書き込みに userClient を使う（本物は RLS の gw_is_sales で通る）。ここでは素通しにする
mock.module(at("lib/supabase.js"), { namedExports: { admin: client, userClient: client } });

let who = null, user = null;
mock.module(at("lib/auth.js"), { namedExports: { requireUser: async () => user, getMemberships: async () => [] } });
const REAL_GW = await import(at("lib/gw.js"));
mock.module(at("lib/gw.js"), {
  namedExports: {
    gwContext: async () => who, canSell: REAL_GW.canSell, canForceAttack: REAL_GW.canForceAttack,
    canApproveAiSales: REAL_GW.canApproveAiSales, canManageAiSales: REAL_GW.canManageAiSales,
  },
});
const logged = [];
mock.module(at("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });

// ---- 偽のサイト ----
const SITES = {
  "sample.co.jp": { "/": `<title>株式会社サンプル</title><a href="/company/">会社概要</a><a href="/contact/">お問い合わせ</a><p>法人向けにPCを大量導入しています</p>`,
    "/company/": "<p>社員120名。東京都千代田区。</p>", "/contact/": "<p>お気軽にご相談ください</p><form></form>", "/robots.txt": "" },
  "block.co.jp": { "/": `<a href="/contact/">お問い合わせ</a>`, "/contact/": "<p>営業目的のお問い合わせはご遠慮ください。</p><form></form>", "/robots.txt": "" },
  "robots.co.jp": { "/": "<p>x</p>", "/robots.txt": "User-agent: *\nDisallow: /\n" },
  "fail.co.jp": { "/": "<p>x</p>", "/robots.txt": "" },
};
const fetched = [];
const REAL_LOOKUP = await import(at("lib/sales-lookup.js"));
mock.module(at("lib/sales-lookup.js"), {
  namedExports: {
    ...REAL_LOOKUP,
    fetchSite: async (url) => {
      fetched.push(url);
      const u = new URL(url);
      const html = SITES[u.hostname]?.[u.pathname];
      if (html === undefined) throw Object.assign(new Error("http_404"), { code: "http", status: 404 });
      return { finalUrl: url, html };
    },
  },
});

// ---- 偽の AI ----
const ai = { calls: [], mode: "ok", usage: null };
const analysisAnswer = (user) => ({
  summary: "法人向けにPCを導入している会社",
  facts: [{ text: "社員120名", source_url: "https://sample.co.jp/company/" }, { text: "売上100億円", source_url: "https://made-up.example/" }],
  hypotheses: ["PCの入替を検討している可能性"], uncertainties: [],
  form_purpose: "general", prohibition: { found: false, quote: "", url: "" },
  services: [
    { service: "8EC・8RENT", fit: 9, need: 8, segment: 7, region: 5, relation: 3, freshness: 5, reason: "PCを大量導入" },
    { service: "ENGER", fit: 3, need: 2, segment: 5, region: 5, relation: 3, freshness: 5, reason: "" },
    { service: "無限道場（企業開拓）", fit: 2, need: 2, segment: 5, region: 5, relation: 3, freshness: 5, reason: "" },
    { service: "無限道場（生徒募集）", fit: 1, need: 1, segment: 5, region: 5, relation: 3, freshness: 5, reason: "" },
  ],
  _user: user,
});
const REAL_CLIENT = await import(at("lib/sales-ai/client.js"));
mock.module(at("lib/sales-ai/client.js"), {
  namedExports: {
    ...REAL_CLIENT,
    aiClient: () => ({
      messages: {
        create: async (p) => {
          ai.calls.push(p);
          if (ai.mode === "throw") throw Object.assign(new Error("overloaded"), { status: 529 });
          const props = p.output_config.format.schema.properties;
          const isDraft = Boolean(props.rationale);
          // 商材の一次分類：本文に「PC」がある会社は pc 8 点、それ以外は 2 点
          if (props.companies) {
            const blocks = [...String(p.messages[0].content).matchAll(/<company no="(\d+)">([\s\S]*?)<\/company>/g)];
            const companies = blocks.map(([, no, text]) => ({ no: Number(no), pc: /PC/.test(text) ? 8 : 2, enger: 3, md_corp: 1, md_student: 0,
              confidence: /サイトの文/.test(text) ? "high" : "low", reason: /PC/.test(text) ? "PCを大量導入" : "手がかりが少ない" }));
            return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ companies }) }], usage: { input_tokens: 5000, output_tokens: 900 } };
          }
          const data = isDraft
            ? { subject: "PCの入替のご相談", body: "{{company}} ご担当者様\n\n{{sender}}と申します。PCの入替をお手伝いします。", rationale: "PCの大量導入の事実から" }
            : analysisAnswer(p.messages[0].content);
          return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(data) }], usage: ai.usage || { input_tokens: 3000, output_tokens: 800 } };
        },
      },
    }),
  },
});
process.env.SALES_AI_ANTHROPIC_API_KEY = "sk-test";

const { default: analyzeApi } = await import(at("api/sales/ai/analyze.js"));
const { default: draftsApi } = await import(at("api/sales/ai/drafts.js"));
const { default: adminApi } = await import(at("api/sales/ai/admin.js"));
const { default: classifyApi } = await import(at("api/sales/ai/classify.js"));
const { default: approachesApi } = await import(at("api/sales/approaches/index.js"));
const { bodyHash } = await import(at("lib/sales-ai/draft.js"));

const emp = (n, name, tenant = T1) => ({ id: id(n), tenant_id: tenant, user_id: `u-${n}`, display_name: name, status: "active" });
const OWNER = { tenantId: T1, isAdmin: false, roles: ["owner"], apps: [], employee: emp(1, "経営 太郎") };
const MGR = { tenantId: T1, isAdmin: false, roles: ["manager"], apps: ["sales"], employee: emp(2, "責任 花子") };
const REP = { tenantId: T1, isAdmin: false, roles: [], apps: ["sales"], employee: emp(3, "営業 一郎") };
const REP2 = { tenantId: T1, isAdmin: false, roles: ["sales"], apps: ["sales"], employee: emp(4, "営業 二郎") };
const MGR_NOAPP = { tenantId: T1, isAdmin: false, roles: ["manager"], apps: [], employee: emp(5, "責任 だけ") };
const NONE = { tenantId: T1, isAdmin: false, roles: [], apps: [], employee: emp(6, "一般") };
const OTHER = { tenantId: T2, isAdmin: false, roles: ["owner"], apps: ["sales"], employee: emp(9, "他社", T2) };
const as = (ctx) => { who = ctx; user = { id: ctx.employee.user_id }; };

function seed() {
  mem.reset();
  ai.calls.length = 0; ai.mode = "ok"; ai.usage = null; fetched.length = 0; ctl.reserveFail = null; logged.length = 0;
  mem.rows.gw_employees = [OWNER, MGR, REP, REP2, MGR_NOAPP, NONE, OTHER].map((c) => ({ ...c.employee }));
  const co = (cid, over) => ({ id: cid, tenant_id: T1, name: `会社${cid.slice(-3)}`, status: "untouched", site_url: null, form_url: null,
    ng_reason: null, hidden_at: null, last_sent_at: null, ...over });
  mem.rows.gw_sales_companies = [
    co(C1, { name: "株式会社サンプル", site_url: "https://sample.co.jp/", form_url: "https://sample.co.jp/contact/", industry: "製造" }),
    co(C_NG, { site_url: "https://sample.co.jp/", ng_reason: "no_sales" }),
    co(C_RECENT, { site_url: "https://sample.co.jp/", last_sent_at: new Date(Date.now() - 3 * 86400000).toISOString() }),
    co(C_NOSITE),
    co(C_BLOCK, { site_url: "https://block.co.jp/" }),
    co(C_ROBOTS, { site_url: "https://robots.co.jp/" }),
    co(C_FAIL, { site_url: "https://fail.co.jp/", service: "03-1234-5678" }),
    { id: C9, tenant_id: T2, name: "他社の会社", status: "untouched", site_url: "https://sample.co.jp/" },
  ];
  mem.rows.gw_sales_ai_settings = [
    { tenant_id: T1, enabled: true, paused_reason: null, monthly_target_usd: 50, monthly_cap_usd: 100, daily_cap_usd: 10, daily_company_limit: 100,
      effective_threshold: 60, focus_services: [], score_profiles: {}, signature: "株式会社エイト {{sender}}", banned_phrases: [] },
  ];
  mem.rows.gw_sales_approaches = [];
  mem.rows.gw_sales_templates = [];
}

function call(handler, method, { body, query = "" } = {}) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
      end(b) { resolve({ status: this.statusCode, body: b ? JSON.parse(b) : null }); } };
    const req = { method, url: `/x${query}`, headers: { host: "gw.example" },
      [Symbol.asyncIterator]: async function* () { if (body) yield Buffer.from(JSON.stringify(body)); } };
    req.on = () => {};
    handler(req, res);
  });
}
const analyze = (ids) => call(analyzeApi, "POST", { body: { companyIds: ids } });

let n = 0, bad = 0;
const t = async (name, fn) => {
  n++;
  try { seed(); await fn(); console.log(`  ok ${name}`); } catch (e) { bad++; console.log(`NG ${name}\n   ${e.stack?.split("\n").slice(0, 3).join("\n   ")}`); }
};

console.log("\n=== 使える人 ===");
await t("Sales を使えない人（権限なし・Salesアプリの無い責任者）は 403", async () => {
  for (const ctx of [NONE, MGR_NOAPP]) {
    as(ctx);
    for (const [h, m] of [[analyzeApi, "GET"], [analyzeApi, "POST"], [draftsApi, "GET"], [draftsApi, "POST"], [adminApi, "GET"], [adminApi, "PATCH"], [classifyApi, "GET"], [classifyApi, "POST"]]) {
      assert.equal((await call(h, m, { query: `?companyId=${C1}`, body: { companyIds: [C1], companyId: C1 } })).status, 403, `${ctx.employee.display_name} ${m}`);
    }
  }
  assert.equal(ai.calls.length, 0);
});
await t("他テナントの会社は分析できず、見えない", async () => {
  mem.rows.gw_sales_ai_settings.push({ ...mem.rows.gw_sales_ai_settings[0], tenant_id: T2 });
  as(OTHER);
  const r = await analyze([C1]);
  assert.equal(r.body.results[0].result, "skipped");
  assert.equal(r.body.results[0].reason, "not_found");
  assert.equal((await call(analyzeApi, "GET", { query: `?companyId=${C1}` })).status, 404);
  assert.equal(ai.calls.length, 0);
});

console.log("\n=== 分析 ===");
await t("1社を分析：読んだページ・出典つきの事実・商材別の点・送信可否（要確認）・台帳", async () => {
  as(REP);
  const r = await analyze([C1]);
  assert.equal(r.status, 200);
  const a = r.body.results[0].analysis;
  assert.equal(r.body.results[0].result, "ok");
  assert.equal(a.bestService, "8EC・8RENT");
  assert.ok(a.score >= 60 && a.effective, `score ${a.score}`);
  assert.deepEqual(a.facts, [{ text: "社員120名", url: "https://sample.co.jp/company/" }], "出典の無い事実は外す");
  assert.ok(a.uncertainties.some((u) => u.includes("売上100億円")));
  assert.equal(a.sendCheck, "manual_review", "禁止の記載が無くても確認済みにはしない");
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].model, "claude-haiku-5-5", "分析は Haiku");
  const usage = mem.rows.gw_sales_ai_usage;
  assert.equal(usage.length, 1);
  assert.equal(usage[0].status, "committed");
  assert.ok(usage[0].cost_usd > 0 && usage[0].cost_usd < usage[0].reserved_usd, "実費は予約より小さい");
  assert.ok(fetched.some((u) => u.endsWith("/robots.txt")));
  const row = mem.rows.gw_sales_ai_analyses[0];
  assert.equal(row.tenant_id, T1);
  assert.equal(row.created_by, "u-3");
  assert.ok(row.score_profile["8EC・8RENT"].fit === 35, "使った配点を写して残す");
});
await t("NG・直近30日・サイトなしは AI を呼ばずに外す", async () => {
  as(REP);
  const r = await analyze([C_NG, C_RECENT, C_NOSITE]);
  assert.deepEqual(r.body.results.map((x) => x.reason), ["ng", "recent", "no_site"]);
  assert.ok(r.body.results.every((x) => x.result === "skipped" && x.reasonLabel));
  assert.equal(ai.calls.length, 0);
  assert.equal((mem.rows.gw_sales_ai_usage || []).length, 0);
});
await t("robots.txt で止められたサイトは読まずに理由を残す（AI は呼ばない）", async () => {
  as(REP);
  const r = await analyze([C_ROBOTS]);
  assert.equal(r.body.results[0].reason, "robots_blocked");
  assert.equal(mem.rows.gw_sales_ai_analyses[0].status, "robots_blocked");
  assert.equal(ai.calls.length, 0);
  assert.deepEqual(fetched, ["https://robots.co.jp/robots.txt"]);
});
await t("営業お断りの記載は、AI の答えに関係なく送信不可", async () => {
  as(REP);
  const r = await analyze([C_BLOCK]);
  const a = r.body.results[0].analysis;
  assert.equal(a.sendCheck, "blocked");
  assert.equal(a.effective, false);
  assert.ok(a.sendCheckReasons.some((x) => x.key === "no_sales" && x.quote.includes("ご遠慮")));
});
await t("止まっている・キーが無い・6社以上は、AI を呼ばない", async () => {
  as(REP);
  mem.rows.gw_sales_ai_settings[0].enabled = false;
  let r = await analyze([C1]);
  assert.equal(r.status, 409); assert.equal(r.body.error, "ai_stopped");
  mem.rows.gw_sales_ai_settings[0].enabled = true;
  delete process.env.SALES_AI_ANTHROPIC_API_KEY;
  r = await analyze([C1]);
  process.env.SALES_AI_ANTHROPIC_API_KEY = "sk-test";
  assert.equal(r.status, 503); assert.equal(r.body.error, "ai_not_configured");
  r = await analyze([C1, C_NG, C_RECENT, C_NOSITE, C_BLOCK, C_ROBOTS]);
  assert.equal(r.status, 400);
  assert.equal(ai.calls.length, 0);
});
await t("予算の予約を断られたら AI を呼ばず「停止」と返す", async () => {
  as(REP);
  ctl.reserveFail = "monthly_cap";
  const r = await analyze([C1]);
  assert.equal(r.body.results[0].result, "stopped");
  assert.equal(r.body.stopped.reason, "monthly_cap");
  assert.ok(r.body.stopped.hint.includes("上限"));
  assert.equal(ai.calls.length, 0);
});
await t("確定で月の上限に達したら止まったことを返す（見込みより多く使ったとき）", async () => {
  as(REP);
  mem.rows.gw_sales_ai_settings[0].monthly_cap_usd = 0.006;
  ai.usage = { input_tokens: 50000, output_tokens: 6000 };
  const r = await analyze([C1]);
  assert.equal(r.body.results[0].result, "ok");
  assert.equal(r.body.stopped?.reason, "paused:monthly_cap");
  assert.equal(mem.rows.gw_sales_ai_settings[0].enabled, false);
});
await t("AI が失敗したら、台帳に error・分析に ai_failed（規則の送信可否は残す）", async () => {
  as(REP);
  ai.mode = "throw";
  const r = await analyze([C_FAIL]);
  assert.equal(r.body.results[0].result, "failed");
  assert.equal(mem.rows.gw_sales_ai_usage[0].outcome, "error");
  assert.equal(mem.rows.gw_sales_ai_usage[0].cost_usd, 0);
  assert.equal(mem.rows.gw_sales_ai_analyses[0].status, "ai_failed");
  assert.equal(mem.rows.gw_sales_ai_analyses[0].send_check, "manual_review");
});
await t("表が無い（db/131 の前）：GET は ready:false、POST は 503", async () => {
  as(REP);
  mem.state.missing = "gw_sales_ai_settings";
  assert.equal((await call(analyzeApi, "GET", { query: `?companyId=${C1}` })).body.ready, false);
  assert.equal((await analyze([C1])).status, 503);
  assert.equal(ai.calls.length, 0);
});

console.log("\n=== 送信可否を人が確かめる ===");
await t("要確認 → 担当者が確認済みにできる。送信不可を覆せるのは承認者だけ（理由必須）", async () => {
  as(REP);
  await analyze([C1, C_BLOCK]);
  const [ok, blocked] = [C1, C_BLOCK].map((c) => mem.rows.gw_sales_ai_analyses.find((a) => a.company_id === c));
  let r = await call(analyzeApi, "PATCH", { body: { id: ok.id, action: "send_check", decision: "ok_manual" } });
  assert.equal(r.status, 200); assert.equal(r.body.analysis.sendCheck, "ok_manual");
  r = await call(analyzeApi, "PATCH", { body: { id: blocked.id, action: "send_check", decision: "ok_manual", note: "誤判定" } });
  assert.equal(r.status, 403, "営業担当は送信不可を覆せない");
  as(MGR);
  r = await call(analyzeApi, "PATCH", { body: { id: blocked.id, action: "send_check", decision: "ok_manual" } });
  assert.equal(r.status, 400, "理由が要る");
  r = await call(analyzeApi, "PATCH", { body: { id: blocked.id, action: "send_check", decision: "ok_manual", note: "採用ページの記載で、問い合わせは可" } });
  assert.equal(r.status, 200);
  as(OTHER);
  assert.equal((await call(analyzeApi, "PATCH", { body: { id: ok.id, action: "send_check", decision: "blocked" } })).status, 404, "他テナントは触れない");
});

console.log("\n=== 営業文と承認 ===");
async function analyzedDraft() {
  as(REP);
  await analyze([C1]);
  const r = await call(draftsApi, "POST", { body: { companyId: C1 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.draft;
}
await t("分析の無い会社・送信不可の会社には作らない", async () => {
  as(REP);
  assert.equal((await call(draftsApi, "POST", { body: { companyId: C1 } })).body.error, "analysis_required");
  await analyze([C_BLOCK]);
  assert.equal((await call(draftsApi, "POST", { body: { companyId: C_BLOCK } })).body.error, "ai_send_blocked");
  assert.equal((await call(draftsApi, "POST", { body: { companyId: C_NG } })).status, 403, "NG の会社");
});
await t("Sonnet で下書きを作る。{{url}} を必ず入れ、作った人を残す", async () => {
  const d = await analyzedDraft();
  assert.equal(d.status, "draft");
  assert.equal(d.service, "8EC・8RENT");
  assert.ok(d.body.includes("{{url}}"));
  assert.equal(d.createdBy, "u-3");
  assert.equal(ai.calls.at(-1).model, "claude-sonnet-5-5");
  assert.equal(mem.rows.gw_sales_ai_usage.filter((u) => u.purpose === "draft").length, 1);
});
await t("承認：営業担当は不可。作った人・依頼した人は不可。別の責任者・経営者なら可（ハッシュを残す）", async () => {
  const d = await analyzedDraft();
  as(REP);
  assert.equal((await call(draftsApi, "PATCH", { body: { id: d.id, action: "approve" } })).status, 403);
  assert.equal((await call(draftsApi, "PATCH", { body: { id: d.id, action: "request" } })).body.draft.status, "pending");
  assert.equal((await call(draftsApi, "PATCH", { body: { id: d.id, action: "approve" } })).body.error, "approver_only");
  // 責任者が作った営業文を、その責任者は承認できない
  as(MGR);
  const own = mem.rows.gw_sales_ai_drafts.find((x) => x.id === d.id);
  own.created_by = "u-2";
  assert.equal((await call(draftsApi, "PATCH", { body: { id: d.id, action: "approve" } })).body.error, "self_approval");
  own.created_by = "u-3";
  const r = await call(draftsApi, "PATCH", { body: { id: d.id, action: "approve", note: "OK" } });
  assert.equal(r.status, 200); assert.equal(r.body.draft.status, "approved");
  const row = mem.rows.gw_sales_ai_drafts.find((x) => x.id === d.id);
  assert.equal(row.decided_by, "u-2");
  assert.equal(row.approved_body_hash, bodyHash(row.subject, row.body));
});
await t("直した人も承認できない。直したら承認をやり直す", async () => {
  const d = await analyzedDraft();
  as(MGR);
  let r = await call(draftsApi, "PATCH", { body: { id: d.id, action: "edit", body: `${d.body}\n追記` } });
  assert.equal(r.body.draft.status, "draft");
  as(REP);
  await call(draftsApi, "PATCH", { body: { id: d.id, action: "request" } });
  as(MGR);
  assert.equal((await call(draftsApi, "PATCH", { body: { id: d.id, action: "approve" } })).body.error, "self_approval");
  as(OWNER);
  assert.equal((await call(draftsApi, "PATCH", { body: { id: d.id, action: "approve" } })).body.draft.status, "approved");
  as(REP);
  r = await call(draftsApi, "PATCH", { body: { id: d.id, action: "edit", body: "書き換え {{url}}" } });
  assert.equal(r.body.draft.status, "draft", "承認済みを直すと下書きに戻る");
  assert.equal(mem.rows.gw_sales_ai_drafts.find((x) => x.id === d.id).approved_body_hash, null);
});
await t("差し戻しは理由が必須。承認待ちの一覧は承認者に canApprove・自分が関わったものに selfInvolved", async () => {
  const d = await analyzedDraft();
  await call(draftsApi, "PATCH", { body: { id: d.id, action: "request" } });
  let r = await call(draftsApi, "GET", { query: "?status=pending" });
  assert.equal(r.body.canApprove, false);
  assert.equal(r.body.drafts[0].selfInvolved, true);
  assert.ok(r.body.drafts[0].preview.body.includes("株式会社サンプル ご担当者様"), "見本は差し込みつき");
  assert.ok(r.body.drafts[0].preview.body.includes("株式会社エイト"), "見本に署名");
  as(MGR);
  r = await call(draftsApi, "GET", { query: "?status=pending" });
  assert.equal(r.body.canApprove, true);
  assert.equal(r.body.drafts[0].selfInvolved, false);
  assert.equal((await call(draftsApi, "PATCH", { body: { id: d.id, action: "reject" } })).status, 400);
  assert.equal((await call(draftsApi, "PATCH", { body: { id: d.id, action: "reject", note: "根拠が弱い" } })).body.draft.status, "rejected");
  as(OTHER);
  assert.equal((await call(draftsApi, "GET", { query: "?status=rejected" })).body.drafts.length, 0, "他テナントには見えない");
});

console.log("\n=== アタック（手動送信）への連携 ===");
async function approvedDraft() {
  const d = await analyzedDraft();
  await call(draftsApi, "PATCH", { body: { id: d.id, action: "request" } });
  as(MGR);
  await call(draftsApi, "PATCH", { body: { id: d.id, action: "approve" } });
  as(REP);
  return d;
}
const prepare = (companyId) => call(approachesApi, "POST", { body: { companyId } });
const sent = (body) => call(approachesApi, "PATCH", { body: { action: "sent", channel: "form", ...body } });
await t("送信不可の会社は専用URLも出さない", async () => {
  as(REP);
  await analyze([C_BLOCK]);
  const r = await prepare(C_BLOCK);
  assert.equal(r.status, 409); assert.equal(r.body.error, "ai_send_blocked");
});
await t("要確認のままではフォームで送信完了にできない（確認すれば送れる・別チャネルなら送れる）", async () => {
  as(REP);
  await analyze([C1]);
  const p = await prepare(C1);
  assert.equal(p.status, 200, "要確認でも、確かめるために開ける");
  let r = await sent({ id: p.body.approach.id, body: "テンプレートの本文" });
  assert.equal(r.status, 409); assert.equal(r.body.error, "ai_send_check_required");
  r = await sent({ id: p.body.approach.id, body: "テンプレートの本文", channel: "email" });
  assert.equal(r.status, 200, "メールで送るなら、フォームの確認は要らない");
});
await t("承認済みの AI 文面で送る：最終文面をサーバが作り直し、ai_draft_id・使用済みを残す", async () => {
  const d = await approvedDraft();
  const an = mem.rows.gw_sales_ai_analyses.find((a) => a.company_id === C1);
  await call(analyzeApi, "PATCH", { body: { id: an.id, action: "send_check", decision: "ok_manual" } });
  const p = await prepare(C1);
  const token = mem.rows.gw_sales_approaches[0].tracking_token;
  const f = await call(draftsApi, "GET", { query: `?id=${d.id}&approachId=${p.body.approach.id}` });
  assert.equal(f.status, 200);
  assert.ok(f.body.final.body.startsWith("株式会社サンプル ご担当者様"));
  assert.ok(f.body.final.body.includes("営業 一郎と申します"), "送る人の名前");
  assert.ok(f.body.final.body.includes(`/r/${token}`), "専用URL");
  assert.ok(f.body.final.body.endsWith("株式会社エイト 営業 一郎"), "共通署名");
  const r = await sent({ id: p.body.approach.id, body: "画面で書き換えた本文（使われない）", aiDraftId: d.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ap = mem.rows.gw_sales_approaches[0];
  assert.equal(ap.ai_draft_id, d.id);
  assert.equal(ap.body, f.body.final.body, "残す本文はサーバが作った最終文面");
  assert.equal(ap.subject, "PCの入替のご相談");
  assert.ok(ap.sent_at);
  const row = mem.rows.gw_sales_ai_drafts.find((x) => x.id === d.id);
  assert.equal(row.status, "used"); assert.equal(row.approach_id, ap.id);
  assert.ok(logged.some((l) => l.action === "sales.attack_sent" && l.detail.aiDraftId === d.id));
});
await t("承認後に書き換わった（ハッシュが合わない）・承認前の営業文では送れない", async () => {
  const d = await approvedDraft();
  const an = mem.rows.gw_sales_ai_analyses.find((a) => a.company_id === C1);
  await call(analyzeApi, "PATCH", { body: { id: an.id, action: "send_check", decision: "ok_manual" } });
  const p = await prepare(C1);
  const row = mem.rows.gw_sales_ai_drafts.find((x) => x.id === d.id);
  row.body += "（こっそり追記）";
  let r = await sent({ id: p.body.approach.id, aiDraftId: d.id });
  assert.equal(r.status, 409); assert.equal(r.body.error, "ai_draft_changed");
  row.status = "pending";
  r = await sent({ id: p.body.approach.id, aiDraftId: d.id });
  assert.equal(r.body.error, "ai_draft_not_approved");
  assert.equal(mem.rows.gw_sales_approaches[0].sent_at, undefined, "送信完了にしていない");
});
await t("AI の表が無い（db/131 の前）ときは、アタックはこれまでどおり", async () => {
  as(REP);
  mem.state.missing = "gw_sales_ai_analyses";
  const p = await prepare(C1);
  assert.equal(p.status, 200);
  assert.equal((await sent({ id: p.body.approach.id, body: "本文" })).status, 200);
});

console.log("\n=== 管理 ===");
await t("開始・停止・設定は経営者・管理者だけ。月の上限は 100 ドルまで", async () => {
  as(MGR);
  assert.equal((await call(adminApi, "PATCH", { body: { action: "pause" } })).status, 403);
  as(OWNER);
  assert.equal((await call(adminApi, "PATCH", { body: { action: "settings", monthlyCapUsd: 150 } })).status, 400);
  assert.equal((await call(adminApi, "PATCH", { body: { action: "settings", monthlyCapUsd: 80, monthlyTargetUsd: 90 } })).status, 400, "目標は上限以下");
  let r = await call(adminApi, "PATCH", { body: { action: "settings", monthlyCapUsd: 80, monthlyTargetUsd: 40, signature: "株式会社エイト" } });
  assert.equal(r.status, 200); assert.equal(r.body.settings.monthlyCapUsd, 80);
  r = await call(adminApi, "PATCH", { body: { action: "pause" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.settings.enabled, false); assert.equal(r.body.settings.pausedReason, "manual");
  r = await call(adminApi, "PATCH", { body: { action: "start" } });
  assert.equal(r.body.settings.enabled, true);
});
await t("費用の集計：確定は実費・予約中は予約額。Vercel・Supabase は別と書く", async () => {
  as(REP);
  await analyze([C1]);
  mem.rows.gw_sales_ai_usage.push({ id: "r1", tenant_id: T1, purpose: "draft", model: "m", status: "reserved", reserved_usd: 0.05, cost_usd: 0, created_at: nowIso() });
  mem.rows.gw_sales_ai_usage.push({ id: "r2", tenant_id: T2, purpose: "draft", model: "m", status: "committed", reserved_usd: 1, cost_usd: 1, created_at: nowIso() });
  const r = await call(adminApi, "GET");
  assert.equal(r.body.usage.month.reservedUsd, 0.05);
  assert.ok(r.body.usage.month.committedUsd > 0 && r.body.usage.month.committedUsd < 0.01, "他テナントの 1 ドルは入らない");
  assert.equal(r.body.usage.month.byPurpose.analysis.calls, 1);
  assert.ok(r.body.costNote.includes("Vercel"));
  assert.equal(r.body.canManage, false);
});

console.log("\n=== 商材の一次分類（候補探し）===");
const classify = (ids) => call(classifyApi, "POST", { body: { companyIds: ids } });
await t("対象・未分類・提案サービス欄が不正な会社の数を返す（企業マスタは読むだけ）", async () => {
  as(REP);
  const r = await call(classifyApi, "GET", { query: "?service=8EC・8RENT" });
  assert.equal(r.status, 200);
  assert.equal(r.body.ready, true);
  // 対象 = サイトあり・NG でない・直近30日にアタックしていない：C1・C_BLOCK・C_ROBOTS・C_FAIL
  assert.equal(r.body.counts.eligible, 4);
  assert.equal(r.body.counts.pending, 4);
  assert.deepEqual(new Set(r.body.pending), new Set([C1, C_BLOCK, C_ROBOTS, C_FAIL]));
  assert.equal(r.body.counts.invalidServiceField, 1, "電話番号が入っている提案サービス欄");
  assert.equal(r.body.candidates.length, 0);
});
await t("20社ずつ分類：登録情報＋トップページ1枚。NG は外し、robots で止められたサイトは登録情報だけ。企業マスタは書き換えない", async () => {
  as(REP);
  const before = JSON.stringify(mem.rows.gw_sales_companies);
  const r = await classify([C1, C_ROBOTS, C_FAIL, C_NG]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.classified, 3);
  assert.equal(r.body.results.find((x) => x.companyId === C_NG).reason, "ng");
  assert.equal(ai.calls.length, 1, "1回の呼び出しでまとめて分類");
  assert.equal(ai.calls[0].model, "claude-haiku-5-5");
  assert.ok(!ai.calls[0].messages[0].content.includes("03-1234-5678"), "不正な提案サービス欄は AI に渡さない");
  const rows = mem.rows.gw_sales_ai_classifications;
  const byId = new Map(rows.map((x) => [x.company_id, x]));
  assert.equal(byId.get(C1).source, "site");
  assert.equal(byId.get(C1).fits["8EC・8RENT"], 8);
  assert.equal(byId.get(C1).best_service, "8EC・8RENT");
  assert.equal(byId.get(C_ROBOTS).source, "meta");
  assert.equal(byId.get(C_ROBOTS).site_status, "robots_blocked");
  assert.equal(byId.get(C_FAIL).service_field_invalid, true);
  assert.ok(rows.every((x) => x.tenant_id === T1));
  assert.ok(!fetched.some((u) => u.startsWith("https://robots.co.jp/") && !u.endsWith("/robots.txt")), "robots で止められたトップは読まない");
  assert.equal(JSON.stringify(mem.rows.gw_sales_companies), before, "企業マスタは1文字も変えない");
  const u = mem.rows.gw_sales_ai_usage;
  assert.equal(u.length, 1); assert.equal(u[0].purpose, "classify"); assert.equal(u[0].status, "committed");
});
await t("候補：選んだ商材が合いそうな順。7点以上の数・詳しい分析の有無も返す。分類し直しても1社1行", async () => {
  as(REP);
  await classify([C1, C_ROBOTS, C_FAIL, C_BLOCK]);
  await classify([C1]);
  assert.equal(mem.rows.gw_sales_ai_classifications.filter((x) => x.company_id === C1).length, 1, "1社1行（上書き）");
  await analyze([C1]);
  const r = await call(classifyApi, "GET", { query: `?service=${encodeURIComponent("8EC・8RENT")}` });
  assert.equal(r.body.counts.pending, 0);
  assert.equal(r.body.counts.strong, 1, "PC の記載があるのは C1 だけ");
  assert.equal(r.body.candidates[0].fit, 8);
  assert.ok(r.body.candidates.findIndex((x) => x.companyId === C_ROBOTS) > 1, "手がかりの少ない会社は下");
  assert.equal(r.body.candidates.find((x) => x.companyId === C1).analysis.status, "ok");
  assert.equal(r.body.candidates.find((x) => x.companyId === C_FAIL).serviceFieldInvalid, true);
  const e = await call(classifyApi, "GET", { query: `?service=${encodeURIComponent("ENGER")}` });
  assert.ok(e.body.candidates.every((x) => x.fit === 3));
  assert.equal((await call(classifyApi, "GET", { query: "?service=unknown" })).status, 400);
});
await t("止まっている・キーが無い・21社以上・予算の予約を断られたら AI を呼ばず、何も書かない", async () => {
  as(REP);
  mem.rows.gw_sales_ai_settings[0].enabled = false;
  assert.equal((await classify([C1])).body.error, "ai_stopped");
  mem.rows.gw_sales_ai_settings[0].enabled = true;
  delete process.env.SALES_AI_ANTHROPIC_API_KEY;
  assert.equal((await classify([C1])).status, 503);
  process.env.SALES_AI_ANTHROPIC_API_KEY = "sk-test";
  assert.equal((await classify(Array.from({ length: 21 }, (_, i) => id(1000 + i)))).status, 400);
  ctl.reserveFail = "daily_cap";
  const r = await classify([C1]);
  assert.equal(r.body.stopped.reason, "daily_cap");
  assert.equal(ai.calls.length, 0);
  assert.equal((mem.rows.gw_sales_ai_classifications || []).length, 0);
});
await t("他テナントの会社は分類できず、候補にも出ない", async () => {
  mem.rows.gw_sales_ai_settings.push({ ...mem.rows.gw_sales_ai_settings[0], tenant_id: T2 });
  as(OTHER);
  const r = await classify([C1]);
  assert.equal(r.body.results[0].reason, "not_found");
  assert.equal(ai.calls.length, 0);
  as(REP);
  await classify([C1]);
  as(OTHER);
  assert.equal((await call(classifyApi, "GET", { query: "" })).body.candidates.length, 0);
});

console.log(`\n合計 ${n} 件中 ${n - bad} 件 通過`);
if (bad) process.exit(1);
