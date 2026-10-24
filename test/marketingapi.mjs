// マーケティング（Office）：原本の取得状態・権限・テナント境界・見るだけで書かない・既読と対応状態の分離・
// 制作予定の版比較・個人情報の歯止め・YouTube の確認と掲載（未対応・二重掲載・確認し直し・一部失敗）を、
// メモリ上の DB と架空データで確かめる。実DB・実メール・YouTube には一切つながない。
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createMemDb } from "./_memdb.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const at = (p) => join(root, p);
const read = (p) => readFileSync(at(p), "utf8");

// ---- SQL（提案・未適用）の要点 ----
const sql = read("db/proposal_marketing.sql");
assert.match(sql, /【提案・未適用】/);
assert.match(sql, /revoke all on public\.gw_marketing_reads, public\.gw_marketing_items, public\.gw_marketing_video_placements\s+from anon, authenticated/, "画面から直接触らせない");
assert.match(sql, /gw_marketing_video_placements_live[\s\S]*where state in \('confirmed', 'published'\)/, "二重掲載を防ぐ一意索引");
assert.match(sql, /check \(state <> 'published' or public_url is not null or source_type is not null\)/, "公開済みには公開URLか原本");
assert.match(read("db/proposal_rollback_marketing.sql"), /drop table if exists public\.gw_marketing_items/);

const T1 = "11111111-1111-4111-8111-111111111111", T2 = "22222222-2222-4222-8222-222222222222";
const U1 = "12345678-1234-4234-8234-000000000001", U2 = "12345678-1234-4234-8234-000000000002";
const E1 = "aaaaaaaa-1111-4111-8111-000000000001", E2 = "aaaaaaaa-2222-4222-8222-000000000002";
const L_NEW = "bbbbbbbb-0000-4000-8000-000000000001", L_OLD = "bbbbbbbb-0000-4000-8000-000000000002";
const L_DONE = "bbbbbbbb-0000-4000-8000-000000000003", L_T2 = "bbbbbbbb-0000-4000-8000-000000000004";
const REC = "bbbbbbbb-0000-4000-8000-000000000005";
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const jstDay = (offsetDays) => new Date(NOW + 9 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);

const mem = createMemDb({
  schema: {
    gw_marketing_reads: { unique: [["tenant_id", "source", "source_id", "user_id"]], noId: true },
    gw_marketing_items: {
      unique: [["tenant_id", "source_type", "source_id"]],
      defaults: () => ({ state: "plan", inquiry_refs: [], version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
      check: (r) => (r.state === "published" && !r.public_url && !r.source_type ? "publish_needs_url" : null),
    },
    gw_marketing_video_placements: { unique: [["tenant_id", "video_id", "site", "position"]] },
  },
});
const db0 = mem.admin();
// 表ごとの「未適用」を再現する（memdb の missing は1表だけなので、ここで包む）
const missing = new Set(["gw_marketing_reads", "gw_marketing_items", "gw_marketing_video_placements"]);
const gone = (name) => {
  const err = { data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${name}' in the schema cache` } };
  const q = new Proxy({}, { get: (_, k) => (k === "then" ? (ok) => Promise.resolve(err).then(ok) : () => q) });
  return q;
};
// 版の自動加算（DB の見張りと同じ）
const db = {
  ...db0,
  from(name) {
    if (missing.has(name)) return gone(name);
    const q = db0.from(name);
    if (name !== "gw_marketing_items") return q;
    const upd = q.update.bind(q);
    q.update = (p) => {
      const cur = (mem.rows.gw_marketing_items || []);
      return { _p: p, eq(k, v) { this._f = [...(this._f || []), [k, v]]; return this; },
        select(c) { this._c = c; return this; },
        maybeSingle() { this._one = true; return this; },
        then(ok, ng) {
          const hit = cur.find((r) => (this._f || []).every(([k, v]) => r[k] === v));
          if (!hit) return Promise.resolve({ data: null, error: null }).then(ok, ng);
          const merged = { ...hit, ...this._p };
          if (merged.state === "published" && !merged.public_url && !merged.source_type) {
            return Promise.resolve({ data: null, error: { code: "23514", message: "check" } }).then(ok, ng);
          }
          Object.assign(hit, this._p, { version: hit.version + 1, updated_at: new Date().toISOString() });
          mem.state.log.push({ table: name, op: "update", n: 1 });
          return Promise.resolve({ data: { ...hit }, error: null }).then(ok, ng);
        } };
    };
    void upd;
    return q;
  },
};

// ---- 架空データ ----
await db0.from("gw_employees").insert([
  { id: E1, tenant_id: T1, user_id: U1, display_name: "架空 担当", status: "active" },
  { id: E2, tenant_id: T2, user_id: U2, display_name: "他社 社員", status: "active" },
]);
const lead = (id, tenant, extra) => ({
  id, tenant_id: tenant, name: `架空 ${id.slice(-1)}`, email: `lead${id.slice(-1)}@example.com`, phone: "090-0000-0000",
  source: "無限道場LP", job_title: "無限道場 カジュアル面談", stage: "applied", status: "todo", recruiter_id: null,
  decision_due_on: null, lead_category: "mugendojo", lead_next_action: null, hold_next_step: null,
  lead_profile: { occupation: "会社員", interests: ["AI活用", "転職"], challenge_text: "AIを仕事に使いたいが、何から始めればよいか分からない。", prefecture: "福岡県" },
  utm_source: "google", utm_medium: "cpc", utm_campaign: "fall", last_contacted_at: null,
  created_at: iso(NOW - 3600000), updated_at: iso(NOW - 3600000), ...extra,
});
await db0.from("gw_hr_applicants").insert([
  lead(L_NEW, T1, { recruiter_id: E1, decision_due_on: jstDay(2) }),
  lead(L_OLD, T1, { created_at: iso(NOW - 5 * 86400000), status: "eval_pending", stage: "casual_interview" }),
  lead(L_DONE, T1, { created_at: iso(NOW - 9 * 86400000), status: "passed" }),
  lead(L_T2, T2, {}),
  { ...lead(REC, T1, {}), lead_category: "recruitment", job_title: "営業" },
]);
await db0.from("gw_hr_timeline").insert([
  { tenant_id: T1, applicant_id: L_NEW, event_key: "applied", label: "無限道場LPからカジュアル面談の申込", detail: null, occurred_at: iso(NOW - 3600000) },
]);
const N_DRAFT = "cccccccc-0000-4000-8000-000000000001", N_PLAN = "cccccccc-0000-4000-8000-000000000002";
const N_PUB = "cccccccc-0000-4000-8000-000000000003", N_OLD = "cccccccc-0000-4000-8000-000000000004";
await db0.from("news_articles").insert([
  { id: N_DRAFT, slug: "column-draft", title: "架空コラム（下書き）", kind: "column", summary: "要約", status: "draft", published_on: null, created_by: "架空 太郎", updated_at: iso(NOW) },
  { id: N_PLAN, slug: "column-plan", title: "架空コラム（予定）", kind: "column", summary: "", status: "published", published_on: jstDay(3), created_by: "架空 太郎", updated_at: iso(NOW) },
  { id: N_PUB, slug: "column-pub", title: "架空コラム（公開）", kind: "column", summary: "", status: "published", published_on: jstDay(-2), created_by: "架空 太郎", updated_at: iso(NOW) },
  { id: N_OLD, slug: "column-old", title: "架空コラム（古い）", kind: "column", summary: "", status: "published", published_on: jstDay(-60), created_by: "架空 太郎", updated_at: iso(NOW) },
]);

// ---- 誰として呼ぶか ----
let who = { id: U1, tenant: T1, roles: ["owner"], isAdmin: false };
const audit = [];
const adapters = {};
const published = [];
mock.module(at("lib/supabase.js"), { namedExports: { admin: () => db, userClient: () => db } });
mock.module(at("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: who.id }), getMemberships: async () => [] } });
mock.module(at("lib/gw.js"), {
  namedExports: {
    gwContext: async () => ({ tenantId: who.tenant, roles: who.roles, isAdmin: who.isAdmin, employee: { id: E1, display_name: "架空 担当" } }),
    accessOf: (c) => {
      const has = (r) => c.roles.includes(r);
      const a = { office: has("owner") || has("manager") || has("finance"), officeApp: has("owner") || c.isAdmin,
        officeHr: has("owner") || has("hr"), officeFinance: has("owner") || has("finance") };
      return { ...a, marketing: a.office || a.officeApp || a.officeHr || a.officeFinance };
    },
    canRecruit: (c) => c.roles.some((r) => ["owner", "manager", "hr", "recruiter"].includes(r)),
  },
});
mock.module(at("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { audit.push(e); } } });
mock.module(at("lib/marketing-sites.js"), { namedExports: { adapterFor: (s) => adapters[s] || null, SITE_ADAPTERS: {} } });
let oembed = async () => ({ status: 200, json: async () => ({ title: "架空の動画", author_name: "架空チャンネル" }) });
globalThis.fetch = async (url, opts) => {
  assert.match(String(url), /^https:\/\/www\.youtube\.com\/oembed\?format=json&url=/, "外へ出るのは oEmbed の確認だけ");
  return oembed(url, opts);
};
const { default: handler } = await import(at("api/marketing/index.js"));

const fakeRes = () => ({ statusCode: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(x) { this.body = JSON.parse(x); } });
async function call(method, url, body) {
  const res = fakeRes();
  await handler({ method, url, body, headers: {} }, res);
  return res;
}
const get = (q) => call("GET", `/api/marketing${q}`);
const post = (b) => call("POST", "/api/marketing", b);
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const writes = () => mem.state.log.length;

// ---- 入口 ----
who = { id: U1, tenant: T1, roles: [], isAdmin: false };
let r = await get("?view=work");
ok(r.statusCode === 403, "Office に入れない人は開けない");
who = { id: U1, tenant: T1, roles: ["owner"], isAdmin: false };

// ---- 見るだけでは何も書かない ----
const w0 = writes();
r = await get("?view=work");
ok(r.statusCode === 200, JSON.stringify(r.body));
ok(r.headers["Cache-Control"] === "no-store", "個人情報を含むのでキャッシュさせない");
const work = r.body;
await get("?count=1");
await get("?view=production");
await get(`?view=work&id=hr_lead:${L_NEW}`);
ok(writes() === w0, "一覧・件数・制作予定・詳細を開いても、DB に1行も書かない");

// ---- 対応が必要な業務 ----
const src = Object.fromEntries(work.sources.map((s) => [s.key, s]));
ok(src.hr_lead.state === "ok" && src.hr_lead.count === 2 && src.hr_lead.total === 3, "無限道場リード：対応待ち2（見送りは除く）");
for (const k of ["mugen_course", "space_inquiry", "ec_order", "ec_contact", "site_contact"]) {
  ok(src[k].state === "not_connected" && src[k].count === null && src[k].need.length > 0, `${k} は未連携（件数は null、必要な作業つき）`);
}
ok(work.items.length === 3 && work.items.every((x) => x.biz === "mugen"), "自社テナントの無限道場リードだけ（採用の応募者・他社は出ない）");
ok(!work.items.some((x) => x.sourceId === L_T2 || x.sourceId === REC), "他社・採用の応募者は混ざらない");
ok(!JSON.stringify(work).includes("@example.com") && !JSON.stringify(work).includes("090-"), "一覧に連絡先を載せない");
const itNew = work.items.find((x) => x.sourceId === L_NEW);
ok(itNew.isNew && itNew.owner?.name === "架空 担当" && itNew.due === jstDay(2), "新着・担当・期限は原本の値");
ok(itNew.points.includes("職業：会社員") && itNew.quote.startsWith("AIを仕事に"), "要点は原本の項目と原文の抜粋だけ");
ok(itNew.next === "カジュアル面談の予約URLを送ってください", `次にやることは採用HRと同じ判定（${itNew.next}）`);
ok(work.items.find((x) => x.sourceId === L_OLD).next === "面談後の次のアクションを選んでください", "面談後は次のアクション");
ok(work.items.find((x) => x.sourceId === L_DONE).status.open === false, "見送りは対応済み");
ok(work.readsReady === false && work.unreadCount === null, "既読の表が未適用なら、未読は「確認できない」（0にしない）");
ok(work.newCount === 1 && work.openCount === 2, "新着1・対応待ち2");

// 採用HRの権限が無い Office の人
who = { id: U1, tenant: T1, roles: ["finance"], isAdmin: false };
r = await get("?view=work");
ok(r.body.sources.find((s) => s.key === "hr_lead").state === "forbidden" && r.body.items.length === 0, "採用HRの権限が無ければ「権限なし」（0件ではない）");
r = await get(`?view=work&id=hr_lead:${L_NEW}`);
ok(r.statusCode === 403, "詳細も権限なし");
r = await post({ action: "read", key: `hr_lead:${L_NEW}` });
ok(r.statusCode === 403, "既読も権限なし");
who = { id: U1, tenant: T1, roles: ["owner"], isAdmin: false };

// ---- 詳細 ----
r = await get(`?view=work&id=hr_lead:${L_NEW}`);
ok(r.statusCode === 200 && r.body.detail.email === "leadw@example.com".replace("w", L_NEW.slice(-1)) && r.body.detail.profile.challenge.includes("何から始めれば"), "詳細で全文と連絡先");
ok(r.body.detail.timeline.length === 1 && r.body.detail.nextActions.some((a) => a.key === "trial"), "最近の記録・次のアクションの候補");
r = await get(`?view=work&id=hr_lead:${L_T2}`);
ok(r.statusCode === 404, "他社のリードは見えない");
r = await get(`?view=work&id=hr_lead:${REC}`);
ok(r.statusCode === 404, "採用の応募者はここでは見えない");
r = await get("?view=work&id=space_inquiry:1");
ok(r.statusCode === 400, "未連携の原本の詳細は取らない");

// ---- 既読（明示操作だけ） ----
r = await post({ action: "read", key: `hr_lead:${L_NEW}` });
ok(r.statusCode === 503 && r.body.error === "not_ready", "既読の表が未適用なら 503（黙って成功にしない）");
missing.delete("gw_marketing_reads");
r = await get("?view=work");
ok(r.body.readsReady === true && r.body.unreadCount === 2, "適用後：未読2");
r = await post({ action: "read", key: `hr_lead:${L_NEW}` });
ok(r.statusCode === 200, "既読にする");
r = await post({ action: "read", key: `hr_lead:${L_NEW}` });
ok(r.statusCode === 200 && (mem.rows.gw_marketing_reads || []).length === 1, "2回押しても1行");
r = await get("?view=work");
ok(r.body.unreadCount === 1 && r.body.items.find((x) => x.sourceId === L_NEW).read === true, "既読は自分だけ・未読1");
ok(r.body.items.find((x) => x.sourceId === L_NEW).status.open === true, "既読にしても対応待ちのまま（既読≠完了）");
r = await post({ action: "read", key: `hr_lead:${L_T2}` });
ok(r.statusCode === 404 && (mem.rows.gw_marketing_reads || []).length === 1, "他社のIDに既読を作らない");
r = await post({ action: "read", key: "space_inquiry:abc" });
ok(r.statusCode === 400, "未連携の原本に既読を作らない");
who = { id: U2, tenant: T1, roles: ["owner"], isAdmin: false };
r = await get("?view=work");
ok(r.body.unreadCount === 2, "別の人には未読のまま");
who = { id: U1, tenant: T1, roles: ["owner"], isAdmin: false };

// ---- 件数（Office ホーム） ----
r = await get("?count=1");
ok(r.statusCode === 200 && r.body.sources.find((s) => s.key === "hr_lead").count === 2 && r.body.sources.find((s) => s.key === "hr_lead").newCount === 1, "件数：無限道場2・新着1");
ok(r.body.sources.find((s) => s.key === "space_inquiry").count === null, "未連携は null");
ok(!JSON.stringify(r.body).includes("架空 "), "件数には氏名を載せない");

// ---- 制作予定 ----
r = await get("?view=production");
let prod = r.body;
const psrc = Object.fromEntries(prod.sources.map((s) => [s.key, s]));
ok(psrc.site_news.state === "ok" && psrc.site_news.olderPublished === 1, "30日より前の公開済みは数だけ（元画面で）");
ok(psrc.plan.state === "not_ready" && psrc.plan.count === null, "制作予定の表が未適用なら「未準備」");
for (const k of ["mugen_contents", "site_marke", "space_articles", "ec_sns"]) ok(psrc[k].state === "not_connected", `${k} は未連携`);
const byId = (id) => prod.items.find((x) => x.key === `site_news:${id}`);
ok(byId(N_DRAFT).state.key === "drafting" && byId(N_DRAFT).publicUrl === null, "下書き→作成中（公開URLなし）");
ok(byId(N_PLAN).state.key === "scheduled" && byId(N_PLAN).scheduledOn === jstDay(3), "未来の公開日→公開予定");
ok(byId(N_PUB).state.key === "published" && byId(N_PUB).publicUrl === "https://8grp.co.jp/news/column-pub/", "公開→公開済み（公開URL）");
ok(!byId(N_OLD), "古い公開済みは並べない");
ok(byId(N_DRAFT).owner === null && byId(N_DRAFT).ownerFrom === "none", "お知らせに担当の項目は無い（書いた人を担当にしない）");
who = { id: U1, tenant: T1, roles: ["manager"], isAdmin: false };
r = await get("?view=production");
ok(r.body.sources.find((s) => s.key === "site_news").state === "forbidden", "サイトのお知らせは管理者・経営者だけ（権限なし）");
who = { id: U1, tenant: T1, roles: ["owner"], isAdmin: false };

// ---- 制作予定の登録 ----
r = await post({ action: "plan.create", biz: "mugen", medium: "column", title: "AIの始め方" });
ok(r.statusCode === 503, "表が未適用なら追加できない（503）");
missing.delete("gw_marketing_items");
r = await post({ action: "plan.create", biz: "mugen", medium: "sns", snsChannel: "x", title: "SNS告知", summary: "連絡は lead@example.com まで" });
ok(r.statusCode === 400 && /メールアドレス/.test(r.body.message), "文案にメールアドレスは入れられない");
r = await post({ action: "plan.create", biz: "mugen", medium: "sns", snsChannel: "x", title: "SNS告知", summary: "電話 090-1234-5678" });
ok(r.statusCode === 400 && /電話番号/.test(r.body.message), "文案に電話番号は入れられない");
r = await post({ action: "plan.create", biz: "mugen", medium: "sns", snsChannel: "x", title: "SNS告知", state: "published" });
ok(r.statusCode === 400 && r.body.error === "needs_public_url", "公開URLなしで公開済みにできない");
r = await post({ action: "plan.create", biz: "mugen", medium: "column", title: "x", inquiryRefs: [{ source: "hr_lead", id: L_T2 }] });
ok(r.statusCode === 404, "他社の問い合わせは紐づけられない");
r = await post({ action: "plan.create", biz: "mugen", medium: "column", title: "x", ownerEmployeeId: E2 });
ok(r.statusCode === 400 && r.body.error === "invalid_owner", "他社の社員を担当にできない");
r = await post({ action: "plan.create", biz: "mugen", medium: "column", title: "x", youtubeUrl: "https://youtu.be/dQw4w9WgXcQ" });
ok(r.statusCode === 400, "動画はYouTube動画の予定にだけ");
r = await post({ action: "plan.create", biz: "mugen", medium: "sns", snsChannel: "x", title: "AIの始め方（SNS）",
  summary: "AIを仕事に使いたい人が最初にやること3つ", ownerEmployeeId: E1, dueOn: jstDay(5),
  inquiryRefs: [{ source: "hr_lead", id: L_NEW }, { source: "hr_lead", id: L_OLD }] });
ok(r.statusCode === 201, JSON.stringify(r.body));
const sns = r.body.item;
ok(JSON.stringify(sns.inquiry_refs) === JSON.stringify([{ source: "hr_lead", id: L_NEW }, { source: "hr_lead", id: L_OLD }]), "紐づけは原本の種類とIDだけ（氏名・本文は写さない）");
ok(audit.some((a) => a.action === "marketing.plan_create"), "監査ログ");
who = { id: U1, tenant: T1, roles: ["finance"], isAdmin: false };
r = await post({ action: "plan.create", biz: "mugen", medium: "column", title: "x", inquiryRefs: [{ source: "hr_lead", id: L_NEW }] });
ok(r.statusCode === 403, "採用HRの権限が無い人は問い合わせを紐づけられない");
r = await get("?view=production");
const seen = r.body.items.find((x) => x.key === `plan:${sns.id}`);
ok(seen.inquiries.length === 0 && seen.hiddenInquiries === 2, "権限の無い人には紐づけを見せない（件数だけ）");
r = await post({ action: "plan.create", biz: "site", medium: "column", title: "x", sourceType: "site_news", sourceId: N_DRAFT });
ok(r.statusCode === 403, "サイトのお知らせとの紐づけは管理者・経営者だけ");
who = { id: U1, tenant: T1, roles: ["owner"], isAdmin: false };

// 版の比較
r = await post({ action: "plan.update", id: sns.id, version: 1, summary: "直した文案" });
ok(r.statusCode === 200 && r.body.item.version === 2, "版1で直す→版2");
r = await post({ action: "plan.update", id: sns.id, version: 1, summary: "古い画面から" });
ok(r.statusCode === 409 && r.body.error === "version_conflict", "古い版からは直せない（409）");
r = await post({ action: "plan.update", id: sns.id, version: 2, state: "published" });
ok(r.statusCode === 400 && r.body.error === "needs_public_url", "公開URLなしで公開済みにしない");
r = await post({ action: "plan.update", id: sns.id, version: 2, publicUrl: "http://x.example/post/1", state: "published" });
ok(r.statusCode === 400, "http の URL は記録しない");
r = await post({ action: "plan.update", id: sns.id, version: 2, publicUrl: "https://x.com/eight/status/1", state: "published" });
ok(r.statusCode === 200 && r.body.item.state === "published" && r.body.item.public_url === "https://x.com/eight/status/1", "手で投稿したあとに公開URLを記録して公開済み");
ok(!mem.state.log.some((l) => /sns|post/i.test(l.table) && l.table !== "gw_marketing_items"), "SNS へは何も送らない（記録だけ）");

// 原本（お知らせ）に担当・期限を付ける
r = await post({ action: "plan.create", biz: "site", medium: "column", title: "架空コラム（下書き）", state: "review", sourceType: "site_news", sourceId: N_DRAFT, ownerEmployeeId: E1 });
ok(r.statusCode === 201, JSON.stringify(r.body));
r = await post({ action: "plan.create", biz: "site", medium: "column", title: "重複", sourceType: "site_news", sourceId: N_DRAFT });
ok(r.statusCode === 409, "同じ原本の制作予定は1つ");
r = await post({ action: "plan.create", biz: "site", medium: "column", title: "x", sourceType: "site_news", sourceId: "cccccccc-0000-4000-8000-0000000000ff" });
ok(r.statusCode === 404, "無い原本には紐づけない");
r = await get("?view=production");
prod = r.body;
ok(!prod.items.some((x) => x.key === `site_news:${N_DRAFT}`) && prod.items.some((x) => x.sourceId === N_DRAFT && x.origin === "plan"), "原本の行は制作予定の行にまとまる（二重に並べない）");
const linked = prod.items.find((x) => x.sourceId === N_DRAFT);
ok(linked.state.key === "review" && linked.originalState === "下書き" && linked.owner === "架空 担当", "原本が下書きの間は制作側の状態（確認待ち）・担当");
ok(prod.employees.some((e) => e.id === E1) && !prod.employees.some((e) => e.id === E2), "担当の候補は自社の社員だけ");

// ---- YouTube ----
const URL1 = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
r = await post({ action: "video.check", url: "https://evil.example/watch?v=dQw4w9WgXcQ" });
ok(r.statusCode === 200 && r.body.ok === false, "YouTube 以外の URL は受けない");
r = await post({ action: "video.check", url: "<iframe src=x>" });
ok(r.body.ok === false, "HTML の貼り付けは受けない");
r = await post({ action: "video.check", url: URL1 });
ok(r.body.ok && r.body.video.embedUrl === "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" && r.body.oembed.state === "embeddable", "公開・埋め込み可");
oembed = async () => ({ status: 401, json: async () => ({}) });
r = await post({ action: "video.check", url: URL1 });
ok(r.body.oembed.state === "not_embeddable", "埋め込み不可（401）");
oembed = async () => ({ status: 404, json: async () => ({}) });
r = await post({ action: "video.check", url: "https://youtu.be/dQw4w9WgXcQ" });
ok(r.body.oembed.state === "unavailable", "非公開・削除（404）");
oembed = async () => { throw new Error("network"); };
r = await post({ action: "video.check", url: URL1 });
ok(r.body.oembed.state === "unknown", "通信失敗は「確認できない」（埋め込み可にしない）");

r = await post({ action: "plan.create", biz: "mugen", medium: "youtube", title: "動画で見る無限道場", youtubeUrl: URL1 });
ok(r.statusCode === 201 && r.body.item.youtube_video_id === "dQw4w9WgXcQ", "動画IDだけを持つ");
const vid = r.body.item.id;
const req = [{ site: "site", position: "お知らせ・コラムの本文", title: "動画で見る無限道場", description: "架空の説明" },
  { site: "space", position: "お知らせ・コラムの本文", title: "動画で見る無限道場" }];
r = await post({ action: "video.preview", itemId: vid, url: URL1, sites: req });
ok(r.statusCode === 200 && r.body.sites.every((s) => !s.supported && s.reason && /^[0-9a-f]{64}$/.test(s.confirmHash)), "どのサイトも未対応（理由つき）");
let prev = r.body.sites;
const placeBody = (sites, extra = {}) => ({ action: "video.place", itemId: vid, url: URL1, publicConfirmed: true, sites, ...extra });
const withHash = (list, pv) => list.map((s) => ({ ...s, confirmHash: pv.find((p) => p.site === s.site).confirmHash }));
who = { id: U1, tenant: T1, roles: ["manager"], isAdmin: false };
r = await post(placeBody(withHash(req, prev)));
ok(r.statusCode === 403, "掲載の確定は管理者・経営者だけ");
who = { id: U1, tenant: T1, roles: ["owner"], isAdmin: false };
r = await post(placeBody(withHash(req, prev), { publicConfirmed: false }));
ok(r.statusCode === 400 && r.body.error === "needs_public_confirmation", "公開動画であることの確認が要る");
const w1 = writes();
r = await post(placeBody(withHash(req, prev)));
ok(r.statusCode === 207 && r.body.ok === false && r.body.results.every((x) => x.result === "unsupported"), "未対応のサイトには載せない（全件成功にしない）");
ok(!(mem.rows.gw_marketing_video_placements || []).length, "未対応なら掲載記録も作らない");
void w1;

// アダプタがあるサイト（テスト用の偽物）で、一部失敗・二重掲載・確認し直し
missing.delete("gw_marketing_video_placements");
adapters.site = { publish: async (p) => { published.push(p); return { ok: true, url: "https://8grp.co.jp/news/x/" }; } };
adapters.space = { publish: async () => ({ ok: false, error: "架空の失敗" }) };
r = await post({ action: "video.preview", itemId: vid, url: URL1, sites: req });
prev = r.body.sites;
ok(prev.every((s) => s.supported), "アダプタがあれば掲載できる表示");
const changed = withHash(req, prev).map((s) => (s.site === "site" ? { ...s, title: "プレビュー後に変えた" } : s));
r = await post(placeBody(changed));
ok(r.statusCode === 409 && r.body.error === "reconfirm" && r.body.sites.includes("site") && published.length === 0, "プレビュー後に変えたら、どこにも載せずに確認し直し");
r = await post(placeBody(withHash(req, prev)));
ok(r.statusCode === 207 && r.body.results.find((x) => x.site === "site").result === "published"
  && r.body.results.find((x) => x.site === "space").result === "failed", "一部失敗は一部失敗として返す");
const rowsP = mem.rows.gw_marketing_video_placements;
ok(rowsP.find((x) => x.site === "site").state === "published" && rowsP.find((x) => x.site === "space").state === "failed", "サイトごとに記録");
r = await post(placeBody(withHash([req[0]], prev)));
ok(r.body.results[0].result === "duplicate" && published.length === 1, "同じ動画・同じ位置には二重に載せない");
ok(audit.filter((a) => a.action === "marketing.video_place").length >= 2, "掲載の操作は監査ログに残る");

// 不正な入力
r = await post({ action: "video.preview", itemId: sns.id, url: URL1, sites: req });
ok(r.statusCode === 400 && r.body.error === "not_video_item", "YouTube動画の予定にだけ");
r = await post({ action: "video.preview", itemId: vid, url: URL1, sites: [{ site: "space", position: "a", title: "t" }, { site: "space", position: "a", title: "t" }] });
ok(r.statusCode === 400, "同じ位置を2回は選べない");
r = await post({ action: "nope" });
ok(r.statusCode === 400, "知らない操作は断る");

// 他社
who = { id: U2, tenant: T2, roles: ["owner"], isAdmin: false };
r = await get("?view=work");
ok(r.body.items.length === 1 && r.body.items[0].sourceId === L_T2, "他社のテナントでは他社のリードだけ");
r = await get("?view=production");
ok(!r.body.items.some((x) => x.origin === "plan"), "他社の制作予定は見えない");
r = await post({ action: "plan.update", id: sns.id, version: 3, title: "他社から" });
ok(r.statusCode === 404, "他社の制作予定は直せない");

console.log(`marketing API: ${pass} checks passed`);
