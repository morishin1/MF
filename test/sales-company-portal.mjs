// Sales の企業詳細「商談準備」「企業ポータル」「オファー・進捗」の API（偽の DB で、ハンドラを直に呼ぶ）。
//
// ■ 確かめること
//   ・ログインなし 401 ／ Sales を使えない人・別テナント 403 ／ Sales の企業一覧に無い企業ID 404
//   ・発行：社内（社員・ENGER メンバー）のメールには発行しない。同じメールは二重に発行しない
//   ・招待リンクの平文は応答で1回だけ。DB にはハッシュだけ。一覧（GET）にはトークン・Auth ID が出ない
//   ・再招待で古いリンクは取り消される。登録済みには再招待しない
//   ・停止：理由が必須。ポータル専用のアカウントだけ Auth も止める（兼用アカウントは止めない）。再開は責任者だけ
//   ・別企業の利用者は、企業IDを差し替えても操作できない
//   ・商談準備：返す人材の項目は許可リストだけ。提示できない人材（稼働中・クローズ）は紐づけない
//   ・進捗：営業担当は自分が担当の提案だけ、責任者は全件
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { createMemDb } from "./_memdb.mjs";
import { sha256 } from "../lib/sales-company-portal.js";

const at = (p) => new URL("../" + p, import.meta.url).pathname;
const TENANT = "4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
const CO_A = "cccccccc-0000-4000-8000-00000000000a";
const CO_B = "cccccccc-0000-4000-8000-00000000000b";
const CO_OUT = "cccccccc-0000-4000-8000-0000000000ff";
const STAFF = "22222222-2222-4222-8222-222222222222";

const mem = createMemDb({
  schema: {
    dx2_company_portal_members: { unique: [["email"]] },
    dx2_company_talent_links: { unique: [["tenant_id", "company_id", "candidate_id"]] },
  },
});
const banCalls = [];
const authUsers = new Map([
  ["auth-portal-only", { id: "auth-portal-only", app_metadata: { apps: ["business"] } }],
  ["auth-shared", { id: "auth-shared", app_metadata: { apps: ["business", "freelance"] } }],
]);
mock.module(at("lib/supabase.js"), { namedExports: { admin: () => {
  const d = mem.admin();
  return { ...d, schema: () => d, auth: { admin: {
    getUserById: async (id) => ({ data: { user: authUsers.get(id) || null }, error: null }),
    updateUserById: async (id, patch) => { banCalls.push({ id, patch }); return { data: {}, error: null }; },
    createUser: async (body) => {
      const user={id:"auth-issued-"+authUsers.size,email:body.email,app_metadata:body.app_metadata};
      authUsers.set(user.id,user);
      return {data:{user},error:null};
    },
    deleteUser: async id => {authUsers.delete(id);return {data:{},error:null};},
  } } };
} } });
let authed = true;
mock.module(at("lib/auth.js"), { namedExports: { requireUser: async (_r, res) => { if (authed) return { id: STAFF }; res.statusCode = 401; res.end("{}"); return null; } } });
let ctx;
const resetCtx = () => { ctx = { tenantId: TENANT, sell: true, isAdmin: false, roles: ["sales"], employee: { id: "emp-sales", display_name: "営業A" } }; };
resetCtx();
mock.module(at("lib/gw.js"), { namedExports: { gwContext: async () => ctx, canSell: (c) => c.sell } });
const gwLogs = [];
mock.module(at("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { gwLogs.push(e); } } });
const mails = [];
let mailReady = false;
mock.module(at("lib/mail/index.js"), { namedExports: {
  mailConfig: () => (mailReady ? { configured: true } : { configured: false, reason: "ENGER_PORTAL_MAIL_FROM が設定されていません" }),
  sendMail: async (m) => { mails.push(m); return { status: mailReady ? "sent" : "skipped", error: mailReady ? null : "未設定" }; },
} });

const portal = (await import("../api/sales/company-portal.js")).default;
const talents = (await import("../api/sales/company-talents.js")).default;
const progress = (await import("../api/sales/company-progress.js")).default;

async function call(handler, method, { query = "", body } = {}) {
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(x) { this.body = x ? JSON.parse(x) : null; } };
  await handler({ method, url: "/api/x" + query, headers: {}, body }, res);
  return res;
}

// 企業一覧（Sales のテナントの範囲）
mem.rows.dx2_sales_company_directory_for_tenant = [
  { id: CO_A, tenant_id: TENANT, name: "企業A" },
  { id: CO_B, tenant_id: TENANT, name: "企業B" },
];
mem.rows.gw_employees = [{ id: "emp-sales", user_id: STAFF, email: "sales.a@8grp.example", display_name: "営業A" }, { id: "emp-other", email: "other@8grp.example", display_name: "営業B" }];
mem.rows.app_users = [{ id: "u1", email: "agent@enger.example", role: "agent", status: "active" }, { id: "u2", email: "client@client-a.example", role: "client", status: "pending" }];

// ---- 認証・範囲 ----------------------------------------------------------------
authed = false; assert.equal((await call(portal, "GET", { query: `?companyId=${CO_A}` })).statusCode, 401); authed = true;
ctx.sell = false; assert.equal((await call(portal, "GET", { query: `?companyId=${CO_A}` })).statusCode, 403); resetCtx();
ctx.tenantId = OTHER_TENANT; assert.equal((await call(portal, "GET", { query: `?companyId=${CO_A}` })).statusCode, 403, "other tenant cannot use the ENGER directory"); resetCtx();
assert.equal((await call(portal, "GET", { query: `?companyId=${CO_OUT}` })).statusCode, 404, "company outside the Sales directory");
assert.equal((await call(portal, "GET", { query: "?companyId=evil" })).statusCode, 400);
assert.equal((await call(portal, "DELETE", { query: `?companyId=${CO_A}` })).statusCode, 405);
for (const h of [talents, progress]) {
  ctx.sell = false; assert.equal((await call(h, "GET", { query: `?companyId=${CO_A}` })).statusCode, 403); resetCtx();
  assert.equal((await call(h, "GET", { query: `?companyId=${CO_OUT}` })).statusCode, 404);
}

// ---- 発行 ----------------------------------------------------------------------
const invite = (body) => call(portal, "POST", { body: { action: "invite", companyId: CO_A, ...body } });
assert.equal((await invite({ email: "bad", displayName: "x" })).statusCode, 400);
assert.equal((await invite({ email: "a@client-a.example", displayName: "" })).statusCode, 400);
assert.equal((await invite({ email: "Sales.A@8grp.example", displayName: "社員" })).body.error, "internal_account", "employees are never portal users");
assert.equal((await invite({ email: "agent@enger.example", displayName: "ENGER" })).body.error, "internal_account", "ENGER staff are never portal users");
const r1 = await invite({ email: "  A@Client-A.example ", displayName: "企業Aの田中", role: "admin", sendMail: true });
assert.equal(r1.statusCode, 200, JSON.stringify(r1.body));
assert.match(r1.body.inviteUrl, /^https:\/\/enger\.jp\/business\/invite\?token=[A-Za-z0-9_-]{43}$/);
const token1 = new URL(r1.body.inviteUrl).searchParams.get("token");
assert.equal(r1.body.mail, "skipped", "mail is not sent when not configured");
const member1 = mem.rows.dx2_company_portal_members[0];
assert.equal(member1.email, "a@client-a.example"); assert.equal(member1.company_id, CO_A); assert.equal(member1.tenant_id, TENANT); assert.equal(member1.role, "admin");
const inv1 = mem.rows.dx2_company_portal_invites[0];
assert.equal(inv1.token_hash, sha256(token1), "only the hash is stored");
assert.ok(!JSON.stringify(mem.rows).includes(token1), "plaintext token is not stored anywhere");
assert.ok(Date.parse(inv1.expires_at) - Date.now() > 6.9 * 86400000);
assert.equal((await invite({ email: "a@client-a.example", displayName: "二重" })).statusCode, 409, "same email twice");
const toB = await call(portal, "POST", { body: { action: "invite", companyId: CO_B, email: "a@client-a.example", displayName: "別企業" } });
assert.equal(toB.body.error, "already_member"); assert.match(toB.body.hint, /別の企業/);
assert.ok(mem.rows.dx2_company_portal_events.some((e) => e.action === "member.invite" && e.company_id === CO_A && e.actor_kind === "staff"));
assert.ok(gwLogs.some((g) => g.action === "sales.portal_invite"));
mailReady = true;
const r2 = await invite({ email: "b@client-a.example", displayName: "企業Aの鈴木", sendMail: true });
assert.equal(r2.body.mail, "sent"); assert.equal(mails.at(-1).to, "b@client-a.example"); assert.equal(mails.at(-1).purpose, "portal");
assert.ok(mails.at(-1).text.includes(r2.body.inviteUrl) && !/パスワード[:：]/.test(mails.at(-1).text), "mail carries the link, never a password");
mailReady = false;

// 一覧：トークン・Auth ID・ハッシュは出ない
const list = await call(portal, "GET", { query: `?companyId=${CO_A}` });
assert.equal(list.statusCode, 200);
assert.equal(list.body.members.length, 2);
assert.equal(list.body.members[0].status, "invited");
const listText = JSON.stringify(list.body);
for (const s of [token1, inv1.token_hash, "auth_user_id", "token_hash"]) assert.ok(!listText.includes(s), `GET must not expose ${s}`);
assert.equal((await call(portal, "GET", { query: `?companyId=${CO_B}` })).body.members.length, 0, "company B sees no company A members");

// 再招待：古いリンクは取り消し
const re = await call(portal, "POST", { body: { action: "reinvite", companyId: CO_A, memberId: member1.id } });
assert.equal(re.statusCode, 200);
assert.ok(mem.rows.dx2_company_portal_invites.find((i) => i.id === inv1.id).revoked_at, "old invite revoked");
assert.notEqual(new URL(re.body.inviteUrl).searchParams.get("token"), token1);
// 別企業IDに差し替えても、企業Aの利用者は操作できない
assert.equal((await call(portal, "POST", { body: { action: "disable", companyId: CO_B, memberId: member1.id, reason: "x" } })).statusCode, 404);
// 登録済み（＝初回設定が済んだ）利用者
member1.auth_user_id = "auth-portal-only"; member1.registered_at = new Date().toISOString();
assert.equal((await call(portal, "POST", { body: { action: "reinvite", companyId: CO_A, memberId: member1.id } })).body.error, "already_registered");
assert.equal((await call(portal, "GET", { query: `?companyId=${CO_A}` })).body.members[0].status, "active");

// 停止・再開
assert.equal((await call(portal, "POST", { body: { action: "disable", companyId: CO_A, memberId: member1.id, reason: " " } })).body.error, "reason_required");
const dis = await call(portal, "POST", { body: { action: "disable", companyId: CO_A, memberId: member1.id, reason: "退職" } });
assert.equal(dis.statusCode, 200); assert.equal(dis.body.authBan.applied, true);
assert.deepEqual(banCalls.at(-1), { id: "auth-portal-only", patch: { ban_duration: "876000h" } });
assert.ok(member1.disabled_at); assert.equal(member1.disabled_reason, "退職");
assert.equal((await call(portal, "POST", { body: { action: "enable", companyId: CO_A, memberId: member1.id } })).statusCode, 403, "sales staff cannot re-enable");
ctx.roles = ["manager"];
const en = await call(portal, "POST", { body: { action: "enable", companyId: CO_A, memberId: member1.id } });
assert.equal(en.statusCode, 200); assert.deepEqual(banCalls.at(-1), { id: "auth-portal-only", patch: { ban_duration: "none" } });
assert.equal(member1.disabled_at, null);
resetCtx();
// 兼用アカウント（フリーランスと兼ねている）は Auth を止めない
const member2 = mem.rows.dx2_company_portal_members[1];
member2.auth_user_id = "auth-shared"; member2.registered_at = new Date().toISOString();
const before = banCalls.length;
const dis2 = await call(portal, "POST", { body: { action: "disable", companyId: CO_A, memberId: member2.id, reason: "契約終了" } });
assert.equal(dis2.body.authBan.applied, false); assert.equal(dis2.body.authBan.reason, "shared_account"); assert.equal(banCalls.length, before);
// 権限
assert.equal((await call(portal, "POST", { body: { action: "role", companyId: CO_A, memberId: member1.id, role: "owner" } })).statusCode, 400);
assert.equal((await call(portal, "POST", { body: { action: "role", companyId: CO_A, memberId: member1.id, role: "member" } })).statusCode, 200);
assert.equal(member1.role, "member");
assert.equal((await call(portal, "POST", { body: { action: "nope", companyId: CO_A, memberId: member1.id } })).statusCode, 400);

// ---- 商談準備 --------------------------------------------------------------------
const cand = (n, extra = {}) => ({
  id: `dddddddd-0000-4000-8000-${String(n).padStart(12, "0")}`, candidate_no: n, initials: "T.Y.", title: "Javaエンジニア", skills: ["Java"],
  exp: "5年", avail: "即日", status: null, created_at: new Date(Date.now() - n * 86400000).toISOString(), is_closed: false, deleted_at: null,
  is_focus: n === 1, remote_pref: "フルリモート", location: "東京都", nearest_station: "渋谷", week_days: "週5", age_band: "30代", nationality: "日本", role_labels: [],
  name: "山田 太郎", email: "taro@partner.example", company: "株式会社パートナー", rate: "75万円", salary_min: 7171, note: "NG企業メモ", affiliation: "一社下", ...extra,
});
mem.rows.candidates = [cand(1), cand(2), cand(3, { status: "稼働中" }), cand(40, { is_closed: true })];
const s1 = await call(talents, "GET", { query: `?companyId=${CO_A}&tab=all` });
assert.equal(s1.statusCode, 200, JSON.stringify(s1.body));
assert.deepEqual(s1.body.rows.map((r) => r.no), [1, 2], "closed / working talents are not shown");
const sText = JSON.stringify(s1.body);
for (const s of ["山田", "taro@", "パートナー", "75万", "7171", "NG企業", "一社下"]) assert.ok(!sText.includes(s), `search must not expose ${s}`);
assert.deepEqual((await call(talents, "GET", { query: `?companyId=${CO_A}&tab=focus` })).body.rows.map((r) => r.no), [1]);
const det = await call(talents, "GET", { query: `?companyId=${CO_A}&id=${cand(1).id}` });
assert.equal(det.statusCode, 200); assert.equal(det.body.talent.talentNo, "P-000001"); assert.ok(det.body.sheet.rows.length > 3);
assert.ok(!JSON.stringify(det.body).includes("山田"));
assert.equal((await call(talents, "GET", { query: `?companyId=${CO_A}&id=${cand(3).id}` })).statusCode, 404, "non-public talent detail is refused");
// 紐づけ：提示できない人材は入らない
const ln = await call(talents, "POST", { body: { companyId: CO_A, talentIds: [cand(1).id, cand(3).id], status: "planned" } });
assert.equal(ln.statusCode, 200); assert.equal(ln.body.linked, 1); assert.deepEqual(ln.body.skipped, [cand(3).id]);
assert.equal(mem.rows.dx2_company_talent_links.length, 1); assert.equal(mem.rows.dx2_company_talent_links[0].status, "planned");
const ln2 = await call(talents, "POST", { body: { companyId: CO_A, talentIds: [cand(1).id, cand(2).id], status: "proposed" } });
assert.deepEqual([ln2.body.created, ln2.body.updated], [1, 1], "re-saving updates status without duplicating");
assert.equal(mem.rows.dx2_company_talent_links.length, 2);
assert.equal((await call(talents, "POST", { body: { companyId: CO_A, talentIds: [cand(3).id] } })).statusCode, 409);
assert.equal((await call(talents, "POST", { body: { companyId: CO_A, talentIds: ["evil"] } })).statusCode, 400);
const linked = await call(talents, "GET", { query: `?companyId=${CO_A}&tab=linked` });
assert.deepEqual(linked.body.rows.map((r) => [r.no, r.link.status]), [[1, "proposed"], [2, "proposed"]]);
assert.equal((await call(talents, "GET", { query: `?companyId=${CO_B}&tab=linked` })).body.rows.length, 0, "links are per company");
const pt = await call(talents, "PATCH", { body: { companyId: CO_A, talentId: cand(1).id, status: "declined", note: "単価が合わず" } });
assert.equal(pt.statusCode, 200); assert.equal(pt.body.link.status, "declined");
assert.equal((await call(talents, "PATCH", { body: { companyId: CO_B, talentId: cand(1).id, status: "saved" } })).statusCode, 404, "cannot edit another company's link");
assert.equal((await call(talents, "PATCH", { body: { companyId: CO_A, talentId: cand(1).id, status: "offered" } })).statusCode, 400);

// ---- 進捗 ----------------------------------------------------------------------
mem.rows.gw_sales_proposals = [
  { id: "p1", tenant_id: TENANT, source_company_id: CO_A, title: "Java / T.Y.", job_title: "Java開発", talent_initials: "T.Y.", status: "meeting_adjust", sales_owner_id: "emp-sales", updated_at: "2026-11-05T00:00:00Z" },
  { id: "p2", tenant_id: TENANT, source_company_id: CO_A, title: "PM / K.S.", status: "won", closed_at: "2026-11-04T00:00:00Z", sales_owner_id: "emp-other", updated_at: "2026-11-04T00:00:00Z" },
  { id: "p3", tenant_id: TENANT, source_company_id: CO_B, title: "別企業", status: "call_wait", sales_owner_id: "emp-sales", updated_at: "2026-11-03T00:00:00Z" },
  { id: "p4", tenant_id: OTHER_TENANT, source_company_id: CO_A, title: "別テナント", status: "call_wait", sales_owner_id: "emp-sales", updated_at: "2026-11-03T00:00:00Z" },
];
const own = await call(progress, "GET", { query: `?companyId=${CO_A}` });
assert.equal(own.body.scope, "own"); assert.deepEqual(own.body.proposals.map((p) => p.id), ["p1"]);
assert.equal(own.body.proposals[0].statusLabel, "面談調整"); assert.equal(own.body.proposals[0].salesOwner, "営業A");
assert.equal(own.body.portalOffers.available, false, "portal offers are Phase 3; not shown as zero");
assert.equal(own.body.prep.counts.declined, 1);
ctx.roles = ["owner"];
const all = await call(progress, "GET", { query: `?companyId=${CO_A}` });
assert.equal(all.body.scope, "all"); assert.deepEqual(all.body.proposals.map((p) => p.id), ["p1", "p2"]);
resetCtx();

// ---- Salesの一般メンバーが8文字の企業ログインを発行・再発行できる ---------------------
resetCtx();
assert.equal(ctx.isAdmin,false);
const issued=await call(portal,"POST",{body:{action:"issue_account",companyId:CO_B,
  confirmed:true,email:"sales-contact@client-b.example",displayName:"企業B担当",role:"member"}});
assert.equal(issued.statusCode,200,JSON.stringify(issued.body));
assert.equal(issued.body.temporaryPassword.length,8);
assert.ok(issued.body.oneTime);
assert.equal(issued.body.member.role,"member");
assert.equal(authUsers.get(mem.rows.dx2_company_portal_members.find(m=>m.company_id===CO_B).auth_user_id).app_metadata.apps[0],"business");
const companyBMember=mem.rows.dx2_company_portal_members.find(m=>m.company_id===CO_B);
// The initial credential is deliberately not retrievable from GET.
const companyBRead=await call(portal,"GET",{query:`?companyId=${CO_B}`});
assert.equal(companyBRead.body.canIssue,true,"non-admin Sales has issuer permission");
assert.equal(companyBRead.body.canEnable,false,"suspended-account reactivation remains privileged");
assert.ok(!JSON.stringify(companyBRead.body).includes(issued.body.temporaryPassword));
const protectedUser=await call(portal,"POST",{body:{action:"issue_account",companyId:CO_B,
  confirmed:true,email:"sales.a@8grp.example",displayName:"社内アカウント",role:"member"}});
assert.equal(protectedUser.statusCode,409);
// A password cannot be changed twice in a short period; records are retained.
assert.equal((await call(portal,"POST",{body:{action:"generate_password",companyId:CO_B,
  memberId:companyBMember.id,confirmed:false}})).statusCode,400);
assert.equal((await call(portal,"POST",{body:{action:"generate_password",companyId:CO_B,
  memberId:companyBMember.id,confirmed:true}})).statusCode,429);
// Simulate a later reset without waiting: only the event timestamp is moved.
for(const ev of mem.rows.dx2_company_portal_events)
  if(ev.company_id===CO_B&&ev.action==="member.temp_password")ev.created_at="2026-10-01T00:00:00Z";
const refreshed=await call(portal,"POST",{body:{action:"generate_password",companyId:CO_B,
  memberId:companyBMember.id,confirmed:true}});
assert.equal(refreshed.statusCode,200,JSON.stringify(refreshed.body));
assert.equal(refreshed.body.temporaryPassword.length,8);
assert.notEqual(refreshed.body.temporaryPassword,issued.body.temporaryPassword);
assert.equal(banCalls.at(-1).patch.password,refreshed.body.temporaryPassword);
assert.equal((await call(portal,"POST",{body:{action:"generate_password",companyId:CO_A,
  memberId:companyBMember.id,confirmed:true}})).statusCode,404);

// ---- 表が未作成（db/161 未適用）：理由を返す。人材の検索は止めない ---------------------
mem.state.missing = "dx2_company_portal_members";
const nr = await call(portal, "GET", { query: `?companyId=${CO_A}` });
assert.equal(nr.statusCode, 503); assert.equal(nr.body.error, "not_ready"); assert.match(nr.body.hint, /db\/161/);
mem.state.missing = "dx2_company_talent_links";
const nr2 = await call(talents, "GET", { query: `?companyId=${CO_A}&tab=all` });
assert.equal(nr2.statusCode, 200); assert.equal(nr2.body.linkReady, false); assert.match(nr2.body.linkHint, /db\/161/);
assert.equal((await call(talents, "GET", { query: `?companyId=${CO_A}&tab=linked` })).statusCode, 503);
mem.state.missing = null;

// 画面：4つのタブと、既存のワークベンチ（企業情報）がそのまま残っている
const html = readFileSync(at("sales/company-segments.html"), "utf8");
for (const [tab, label] of [["info", "企業情報"], ["prep", "商談準備"], ["portal", "企業ポータル"], ["offers", "オファー・進捗"]]) {
  assert.match(html, new RegExp(`data-modal-tab="${tab}"[^>]*>${label}<`), `tab ${label}`);
}
assert.match(html, /<div id="lc-detail" role="tabpanel"/, "existing workbench container is the first tab");
const seg = readFileSync(at("js/sales-company-segments.js"), "utf8");
assert.match(seg, /tabs\.open\(r\);\s*return workbench\.open\(r\);/, "row click opens tabs and the existing workbench");
assert.match(seg, /tabs\.open\(target\);await workbench\.open\(target\);/, "history click resets tabs too");
const ui = readFileSync(at("js/sales-company-portal-tabs.js"), "utf8");
assert.ok(!/innerHTML\s*=\s*[^;]*\$\{(?!esc\()[a-z]+\.(name|email|displayName|title)\b/.test(ui), "UI escapes values before inserting HTML");
assert.match(ui, /この画面を閉じると二度と表示されません/, "invite link shown once");
console.log("PASS Sales company portal: auth & isolation, invite hashing & once-only URL, internal email refusal, ban rules, manager re-enable, public-only talent linking, proposal scope, four tabs");
