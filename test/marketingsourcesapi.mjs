// マーケティング：各事業の原本（8sp・無限道場の受講申込・問い合わせの表）を、本人の権限のまま読む・動かす。
// 偽の DB（RLS と各事業の関数をまねる）と架空データだけ。実DB・実メール・8sp には一切つながない。
//
//   ・その事業の権限が無い → 「権限なし」（RLS で0行になるのを0件と見せない）
//   ・その事業の仕組みが DB に無い（別プロジェクト） → 「未連携」
//   ・見るだけ（一覧・件数・詳細）では、どの事業にも書かない
//   ・8sp：対応完了・再開・メモ・予約の承認/却下は 8sp の関数、メールは 8sp のメールAPI（本人のトークン・宛先は渡さない）
//   ・問い合わせの表：状態とメモだけ、開いたあとに変わっていたら 409
//   ・受講申込：読むだけ
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createMemDb } from "./_memdb.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const at = (p) => join(root, p);
const T1 = "11111111-1111-4111-8111-111111111111";
const U1 = "12345678-1234-4234-8234-000000000001";
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const id = (n) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, "0")}`;

const mem = createMemDb({ schema: { gw_marketing_reads: { unique: [["tenant_id", "source", "source_id", "user_id"]], noId: true } } });
const db = mem.admin();

// ---- 架空の原本 ----
const R_NEW = id(1), R_BOOK = id(2), R_DONE = id(3), R_OTHER = id(4);
const B_TENT = id(11), B_CONF = id(12), B_OTHER = id(13);
const G1 = id(21), G2 = id(22);
await db.from("rental_records").insert([
  { id: R_NEW, kind: "問い合わせ", name: "架空商事", contact_person: "架空 花子", email: "hanako@example.com", phone: "090-0000-0001",
    source: "instabase", recv_date: "2026-10-23", use_date: "2026-11-05", use_end: null, use_time: "13:00-17:00", headcount: 12,
    purpose: "社内研修", form_content: "11/5 の午後、12名で研修に使いたいです。プロジェクターはありますか。", staff: "架空 事務",
    status: "未対応", guide_status: "新規", booking_group_id: null, member_id: null, created_at: iso(NOW - 3600000), updated_at: iso(NOW - 3600000) },
  { id: R_BOOK, kind: "予約", name: "架空 太郎", contact_person: null, email: "taro@example.com", phone: null, source: "8sp.jp",
    recv_date: "2026-10-20", use_date: "2026-11-10", use_end: null, use_time: "10:00-12:00", headcount: 4, purpose: "打合せ",
    form_content: "打合せで使います", staff: null, status: "仮押さえ", guide_status: "仮予約済み", booking_group_id: G1, member_id: id(31),
    created_at: iso(NOW - 4 * 86400000), updated_at: iso(NOW - 2 * 86400000) },
  { id: R_DONE, kind: "問い合わせ", name: "架空 古い", contact_person: null, email: null, phone: null, source: "電話", recv_date: "2026-01-01",
    use_date: null, use_end: null, use_time: null, headcount: null, purpose: null, form_content: "昔の問い合わせ", staff: null, status: "失注",
    guide_status: "対応完了", booking_group_id: null, member_id: null, created_at: iso(NOW - 200 * 86400000), updated_at: iso(NOW - 199 * 86400000) },
  { id: R_OTHER, kind: "予約", name: "別の人", contact_person: null, email: "other@example.com", phone: null, source: "8sp.jp", recv_date: "2026-10-22",
    use_date: "2026-11-10", use_end: null, use_time: "11:00-13:00", headcount: 2, purpose: "面談", form_content: "", staff: null, status: "仮押さえ",
    guide_status: "仮予約済み", booking_group_id: G2, member_id: id(32), created_at: iso(NOW - 2 * 86400000), updated_at: iso(NOW - 2 * 86400000) },
]);
await db.from("space_bookings").insert([
  { id: B_TENT, group_id: G1, member_id: id(31), starts_at: "2026-11-10T01:00:00Z", ends_at: "2026-11-10T03:00:00Z", purpose: "打合せ", headcount: 4, status: "tentative", amount: 6000, admin_comment: null },
  { id: B_CONF, group_id: G1, member_id: id(31), starts_at: "2026-11-11T01:00:00Z", ends_at: "2026-11-11T03:00:00Z", purpose: "打合せ", headcount: 4, status: "confirmed", amount: 6000, admin_comment: null },
  { id: B_OTHER, group_id: G2, member_id: id(32), starts_at: "2026-11-10T02:00:00Z", ends_at: "2026-11-10T04:00:00Z", purpose: "面談", headcount: 2, status: "tentative", amount: 4000, admin_comment: null },
]);
const C1 = id(41), C2 = id(42);
await db.from("lms.course_applications").insert([
  { id: C1, course: "AIで仕事とアイデアを形にする実践講座", name: "架空 受講", kana: "かくう じゅこう", email: "juko@example.com", tel: "090-0000-0003",
    style: "オンライン", motivation: "業務の自動化を学びたい", applicant: "法人", org: "架空株式会社", dept: "総務部", note: null, status: "new",
    created_at: iso(NOW - 7200000), updated_at: iso(NOW - 7200000) },
  { id: C2, course: "AIで仕事とアイデアを形にする実践講座", name: "架空 決定", kana: "かくう けってい", email: "kettei@example.com", tel: "090-0000-0004",
    style: "対面", motivation: "", applicant: "個人", org: null, dept: null, note: "受講決定済み", status: "enrolled",
    created_at: iso(NOW - 20 * 86400000), updated_at: iso(NOW - 10 * 86400000) },
]);
const Q_SITE = id(51), Q_EC = id(52), Q_UNK = id(53);
await db.from("contact_submissions").insert([
  { id: Q_SITE, source: "8grp_lp", inquiry_type: "無料相談", name: "架空 会社HP", company: "架空工業", email: "site@example.com", phone: null,
    message: "DXの相談をしたいです", status: "未対応", staff_memo: null, created_at: iso(NOW - 1800000), updated_at: iso(NOW - 1800000) },
  { id: Q_EC, source: "pc", inquiry_type: "お見積もり", name: "架空 EC", company: null, email: "ec@example.com", phone: "090-0000-0005",
    message: "PCを10台レンタルしたい", status: "対応中", staff_memo: "見積送付予定", created_at: iso(NOW - 3 * 86400000), updated_at: iso(NOW - 86400000) },
  { id: Q_UNK, source: "enger_unknown", inquiry_type: "その他", name: "架空 不明", company: null, email: null, phone: null,
    message: "どこからか分からない", status: "未対応", staff_memo: null, created_at: iso(NOW - 86400000), updated_at: iso(NOW - 86400000) },
]);
const notes = [{ record_id: R_NEW, at: iso(NOW - 1000), author_name: "架空 事務", body: "折り返し電話する", important: false, same_record: true }];
const events = [{ record_id: R_NEW, at: iso(NOW - 3600000), actor_name: null, actor_kind: "system", kind: "受付", detail: "instabase から" }];
const mails = [];

// ---- 各事業の「本人の権限」（RLS と関数）をまねる ----
const st = { spaceStaff: true, lmsStaff: true, zimu: true, missing: false };
const rpcWrites = [];
const deny = () => { const q = new Proxy({}, { get: (_, k) => (k === "then" ? (ok) => Promise.resolve({ data: [], error: null }).then(ok)
  : k === "maybeSingle" || k === "single" ? () => ({ then: (ok) => Promise.resolve({ data: null, error: null }).then(ok) }) : () => q) }); return q; };
const allowed = { rental_records: () => st.spaceStaff, space_bookings: () => st.spaceStaff, contact_submissions: () => st.zimu, "lms.course_applications": () => st.lmsStaff };
const gone = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
const rpcErr = (m) => ({ data: null, error: { code: "P0001", message: m } });
const userDb = {
  ...db,
  from(t) {
    if (allowed[t] && st.missing) return new Proxy({}, { get: (_, k) => (k === "then" ? (ok) => Promise.resolve({ data: null, error: { code: "PGRST205", message: "not found" } }).then(ok) : function () { return this; }) });
    if (allowed[t] && !allowed[t]()) return deny();
    return db.from(t);
  },
  schema(name) { return { from: (t) => userDb.from(`${name}.${t}`) }; },
  async rpc(fn, a = {}) {
    if (st.missing) return gone;
    const rows = mem.rows.rental_records || [];
    switch (fn) {
      case "space_is_staff": return { data: st.spaceStaff, error: null };
      case "is_lms_staff": return { data: st.lmsStaff, error: null };
      case "zimu_is_admin": return { data: st.zimu, error: null };
      case "space_inquiry_admin_list":
        return { data: !st.spaceStaff ? [] : rows.map((r) => ({ id: r.id, kind: r.kind, recv_date: r.recv_date,
          person: r.contact_person || r.name, org: r.contact_person ? r.name : null, email: r.email, phone: r.phone, source: r.source,
          purpose: r.purpose, form_content: r.form_content, use_date: r.use_date, use_end: r.use_end, use_time: r.use_time,
          wish: r.use_date ? `${r.use_date} ${r.use_time || ""}`.trim() : null, headcount: r.headcount, guide_status: r.guide_status,
          member_name: null, has_invite: false, has_member: Boolean(r.member_id), has_booking: Boolean(r.booking_group_id),
          booking_count: (mem.rows.space_bookings || []).filter((b) => b.group_id === r.booking_group_id).length,
          booking_state: r.booking_group_id ? "仮予約" : null, created_at: r.created_at })), error: null };
      case "space_inquiry_events_of": return { data: st.spaceStaff ? events.filter((e) => e.record_id === a.p_record_id) : [], error: null };
      case "space_inquiry_notes_of": return { data: st.spaceStaff ? notes.filter((e) => e.record_id === a.p_record_id) : [], error: null };
      case "space_mail_log_of": return { data: st.spaceStaff ? mails.filter((e) => e.record_id === a.p_record_id) : [], error: null };
      case "space_set_inquiry_done": case "space_reopen_inquiry": {
        if (!st.spaceStaff) return rpcErr("forbidden");
        const r = rows.find((x) => x.id === a.p_record_id);
        if (!r) return rpcErr("not_found");
        r.guide_status = fn === "space_set_inquiry_done" ? "対応完了" : (r.booking_group_id ? "仮予約済み" : "新規");
        rpcWrites.push(fn);
        return { data: [{ guide_status: r.guide_status }], error: null };
      }
      case "space_add_inquiry_note": {
        if (!st.spaceStaff) return rpcErr("forbidden");
        notes.push({ record_id: a.p_record_id, at: iso(Date.now()), author_name: "架空 本人", body: a.p_body, important: a.p_important, same_record: true });
        rpcWrites.push(fn);
        return { data: [{ id: id(99) }], error: null };
      }
      case "space_admin_decide_booking": {
        if (!st.spaceStaff) return rpcErr("forbidden");
        const b = (mem.rows.space_bookings || []).find((x) => x.id === a.p_id);
        if (!b) return rpcErr("not_found");
        if (a.p_action === "reject" && !a.p_comment) return rpcErr("comment_required");
        // 8sp の見張り：確定した予約と重なる承認は止める
        if (a.p_action === "approve" && (mem.rows.space_bookings || []).some((x) => x.id !== b.id && x.status === "confirmed"
          && x.starts_at < b.ends_at && b.starts_at < x.ends_at)) return rpcErr("この時間は、ほかの予約と重なっています");
        b.status = a.p_action === "approve" ? "confirmed" : "rejected";
        b.admin_comment = a.p_comment;
        rpcWrites.push(fn);
        return { data: b, error: null };
      }
      default: return gone;
    }
  },
};

const audit = [];
let who = { id: U1, tenant: T1, roles: [], isAdmin: false, apps: ["marketing"] };
mock.module(at("lib/supabase.js"), { namedExports: { admin: () => db, userClient: () => userDb } });
mock.module(at("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: who.id }), getMemberships: async () => [] } });
mock.module(at("lib/gw.js"), {
  namedExports: {
    gwContext: async () => ({ tenantId: who.tenant, roles: who.roles, isAdmin: who.isAdmin, apps: who.apps, employee: { id: "e1" } }),
    accessOf: (c) => ({ marketing: c.roles.includes("owner") || (c.apps || []).includes("marketing") }),
    canRecruit: () => false,
  },
});
mock.module(at("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { audit.push(e); } } });
// 8sp のメールAPI（偽物）。本人のトークンのまま届くか・宛先を渡していないか・同じ下書きは2回送れないか
const MAIL_URL = "https://8sp.test/api/send-mail";
const mailCalls = [];
let mailMode = "ok";
const sentDrafts = new Set();
globalThis.fetch = async (url, opts) => {
  assert.equal(url, MAIL_URL, "外へ出るのは 8sp のメールAPIだけ");
  const body = JSON.parse(opts.body);
  mailCalls.push({ auth: opts.headers.authorization, body });
  if (mailMode === "timeout") throw new Error("timeout");
  const send = (status, b) => ({ ok: status < 300, status, json: async () => b });
  if (body.action === "compose") {
    return send(200, { ok: true, mail_id: id(61), kind: "案内", status: "draft", to: "hanako@example.com", subject: "【8sp】お問い合わせありがとうございます", body: "架空 花子 様\nご案内です。" });
  }
  if (body.action === "send-draft") {
    if (sentDrafts.has(body.mail_id)) return send(400, { ok: false, message: "そのメールは送れません。すでに送ったか、送らないと決めたものです。" });
    sentDrafts.add(body.mail_id);
    return send(200, { ok: true, sent: true, mail_id: body.mail_id, to: "hanako@example.com" });
  }
  return send(400, { ok: false, message: "unknown" });
};
const { default: handler } = await import(at("api/marketing/index.js"));
const fakeRes = () => ({ statusCode: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(x) { this.body = JSON.parse(x); } });
async function call(method, url, body) {
  const res = fakeRes();
  await handler({ method, url, body, headers: { authorization: "Bearer user-token-1" } }, res);
  return res;
}
const get = (q) => call("GET", `/api/marketing${q}`);
const post = (b) => call("POST", "/api/marketing", b);
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const src = (w, k) => w.sources.find((s) => s.key === k);
const kv = (rows, k) => (rows.find(([key]) => key === k) || [])[1];

// ================= 見るだけ：どこにも書かない =================
const w0 = mem.state.log.length;
let r = await get("?view=work");
ok(r.statusCode === 200, JSON.stringify(r.body).slice(0, 300));
const W = r.body;
await get("?count=1");
await get(`?view=work&id=space_inquiry:${R_NEW}`);
await get(`?view=work&id=mugen_course:${C1}`);
await get(`?view=work&id=site_contact:${Q_SITE}`);
ok(mem.state.log.length === w0 && rpcWrites.length === 0 && mailCalls.length === 0, "一覧・件数・詳細を開いても、どの事業にも書かない・メールAPIも呼ばない");

// ================= スペース（8sp） =================
ok(src(W, "space_inquiry").state === "ok" && src(W, "space_inquiry").count === 3, `8sp：未完了3件（60日より前に完了したものは出さない）（${src(W, "space_inquiry").count}）`);
const sp = W.items.find((x) => x.sourceId === R_NEW);
ok(sp.from === "架空 花子（架空商事）" && sp.subject === "社内研修" && sp.points.some((p) => p.includes("12名")), "送信者・用件・人数");
ok(sp.owner?.name === "架空 事務" && sp.next.includes("案内メール"), "担当（事務ポータル）・次の対応（8sp と同じ言い方）");
ok(!JSON.stringify(W.items).includes("hanako@example.com"), "一覧に連絡先を載せない");
ok(!W.items.some((x) => x.sourceId === R_DONE), "200日前に完了したものは出さない");
r = await get(`?view=work&id=space_inquiry:${R_NEW}`);
const v = r.body.view;
ok(kv(v.contact, "メール") === "hanako@example.com" && v.body.text.includes("プロジェクター"), "詳細：送信者と原文");
ok(kv(v.fields, "希望日時") === "2026-11-05 13:00-17:00" && kv(v.fields, "人数") === "12名", "詳細：予約内容（希望日時・人数）");
ok(v.history.some((h) => h.kind === "note" && h.detail === "折り返し電話する") && v.history.some((h) => h.label === "受付"), "詳細：対応履歴（8sp の記録・メモ）");
ok(v.actions.done && !v.actions.reopen && v.actions.reply, "詳細：できる操作（対応完了・返信）");
ok(v.actions.replyVia === null && /SPACE_MAIL_API_URL/.test(v.actions.replyNote), "メールAPIの場所が未設定なら、返信はできないと出す");
r = await get(`?view=work&id=space_inquiry:${R_BOOK}`);
ok(r.body.view.bookings.length === 2 && r.body.view.bookings.find((b) => b.id === B_TENT).canDecide
  && !r.body.view.bookings.find((b) => b.id === B_CONF).canDecide, "予約：仮予約だけ承認・却下できる");

// 対応完了・再開・メモ（8sp の関数）
r = await post({ action: "space.done", key: `space_inquiry:${R_NEW}` });
ok(r.statusCode === 200 && mem.rows.rental_records.find((x) => x.id === R_NEW).guide_status === "対応完了" && rpcWrites.includes("space_set_inquiry_done"), "対応完了は 8sp の space_set_inquiry_done");
r = await post({ action: "space.reopen", key: `space_inquiry:${R_NEW}` });
ok(r.statusCode === 200 && mem.rows.rental_records.find((x) => x.id === R_NEW).guide_status === "新規", "再開は 8sp の space_reopen_inquiry");
r = await post({ action: "space.note", key: `space_inquiry:${R_NEW}`, body: "  " });
ok(r.statusCode === 400, "空のメモは残さない");
r = await post({ action: "space.note", key: `space_inquiry:${R_NEW}`, body: "見積を送った" });
ok(r.statusCode === 200 && notes.some((n) => n.body === "見積を送った"), "メモは 8sp の space_add_inquiry_note");
ok(audit.some((a) => a.action === "marketing.space_done") && audit.some((a) => a.action === "marketing.space_note"), "MF の監査ログにも残す（本文は残さない）");
ok(!audit.some((a) => JSON.stringify(a.detail || {}).includes("見積を送った")), "監査ログにメモの本文を残さない");

// 予約の承認・却下（8sp の space_admin_decide_booking）
r = await post({ action: "space.booking", key: `space_inquiry:${R_BOOK}`, bookingId: B_OTHER, decision: "approve" });
ok(r.statusCode === 404, "別のお問い合わせの予約は、ここから動かさない");
r = await post({ action: "space.booking", key: `space_inquiry:${R_BOOK}`, bookingId: B_TENT, decision: "reject" });
ok(r.statusCode === 400 && r.body.error === "comment_required", "却下は理由が必須");
r = await post({ action: "space.booking", key: `space_inquiry:${R_BOOK}`, bookingId: B_CONF, decision: "approve" });
ok(r.statusCode === 409 && r.body.error === "already_decided", "確定済みの予約は承認し直さない");
// 重なり：別グループの仮予約（11/10 11:00-13:00 JST）を先に確定 → こちら（10:00-12:00）の承認は 8sp が止める
mem.rows.space_bookings.find((x) => x.id === B_OTHER).status = "confirmed";
r = await post({ action: "space.booking", key: `space_inquiry:${R_BOOK}`, bookingId: B_TENT, decision: "approve" });
ok(r.statusCode === 409 && r.body.error === "rejected_by_8sp" && /重なって/.test(r.body.message), "二重予約は 8sp の見張りが止め、その理由を出す");
ok(mem.rows.space_bookings.find((x) => x.id === B_TENT).status === "tentative", "止められたら予約は仮予約のまま");
mem.rows.space_bookings.find((x) => x.id === B_OTHER).status = "tentative";
r = await post({ action: "space.booking", key: `space_inquiry:${R_BOOK}`, bookingId: B_TENT, decision: "approve" });
ok(r.statusCode === 200 && mem.rows.space_bookings.find((x) => x.id === B_TENT).status === "confirmed", "重ならなければ承認（8sp の処理）");
r = await post({ action: "space.booking", key: `space_inquiry:${R_BOOK}`, bookingId: B_TENT, decision: "approve" });
ok(r.statusCode === 409 && r.body.error === "already_decided", "二度押しでも2回は承認しない");

// メール（8sp のメールAPI。作る → 確認 → 送る）
r = await post({ action: "space.mail.compose", key: `space_inquiry:${R_NEW}` });
ok(r.statusCode === 503 && r.body.error === "mail_not_configured", "メールAPIの場所が未設定なら作らない");
process.env.SPACE_MAIL_API_URL = MAIL_URL;
r = await post({ action: "space.mail.compose", key: `space_inquiry:${R_NEW}` });
ok(r.statusCode === 200 && r.body.preview.to === "hanako@example.com" && r.body.preview.from && r.body.preview.mailId === id(61), "下書きの宛先・送信元・件名・本文を見せる");
ok(mailCalls[0].auth === "Bearer user-token-1" && mailCalls[0].body.record_id === R_NEW && !("to" in mailCalls[0].body), "本人のトークンのまま・宛先は渡さない（8sp が DB から引く）");
r = await post({ action: "space.mail.send", key: `space_inquiry:${R_NEW}`, mailId: id(61), subject: "件名", body: "本文" });
ok(r.statusCode === 400 && r.body.error === "needs_confirmation", "確認なしでは送らない");
r = await post({ action: "space.mail.send", key: `space_inquiry:${R_NEW}`, mailId: id(61), subject: "件名", body: "本文", confirmed: true });
ok(r.statusCode === 200 && r.body.outcome === "sent", "確認したら、その1通だけ送る");
r = await post({ action: "space.mail.send", key: `space_inquiry:${R_NEW}`, mailId: id(61), subject: "件名", body: "本文", confirmed: true });
ok(r.statusCode === 400 && /すでに送った/.test(r.body.message), "同じ下書きは2回送らない（8sp が断る）");
mailMode = "timeout";
r = await post({ action: "space.mail.send", key: `space_inquiry:${R_NEW}`, mailId: id(62), subject: "件名", body: "本文", confirmed: true });
ok(r.statusCode === 202 && r.body.outcome === "unknown", "時間切れは「分からない」（すぐに送り直さない）");
mailMode = "ok";
delete process.env.SPACE_MAIL_API_URL;

// 8sp の権限が無い
st.spaceStaff = false;
r = await get("?view=work");
ok(src(r.body, "space_inquiry").state === "forbidden" && src(r.body, "space_inquiry").count === null, "8sp の権限が無ければ「権限なし」（RLS の0行を0件と見せない）");
ok(!r.body.items.some((x) => x.source === "space_inquiry"), "権限なしなら1件も出さない");
r = await get(`?view=work&id=space_inquiry:${R_NEW}`);
ok(r.statusCode === 403, "詳細も権限なし");
r = await post({ action: "space.done", key: `space_inquiry:${R_NEW}` });
ok(r.statusCode === 403, "操作も 8sp が断る");
r = await post({ action: "read", key: `space_inquiry:${R_NEW}` });
ok(r.statusCode === 403, "見えないものに既読を作らない");
st.spaceStaff = true;

// ================= 無限道場：受講申込（読むだけ） =================
const cs = src(W, "mugen_course");
ok(cs.state === "ok" && cs.count === 1 && cs.total === 2, "受講申込：未対応1・全2");
const c1 = W.items.find((x) => x.sourceId === C1);
ok(c1.typeLabel === "受講申込（法人）" && c1.from === "架空 受講（架空株式会社）" && c1.status.label === "未対応" && c1.ownerMissing, "法人の申込・状態・担当は原本に項目なし");
r = await get(`?view=work&id=mugen_course:${C1}`);
ok(r.body.view.body.text === "業務の自動化を学びたい" && kv(r.body.view.contact, "部署") === "総務部" && /読むだけ/.test(r.body.view.actions.readOnlyNote), "詳細：原文・法人の項目・読むだけと明示");
st.lmsStaff = false;
r = await get("?view=work");
ok(src(r.body, "mugen_course").state === "forbidden" && /講師・管理者/.test(src(r.body, "mugen_course").hint), "無限道場の権限が無ければ「権限なし」");
st.lmsStaff = true;

// ================= 問い合わせの表（EC・会社HP） =================
ok(src(W, "site_contact").state === "ok" && src(W, "site_contact").count === 1 && src(W, "ec_contact").count === 1, "会社HP1・EC1（送信元ページで分ける）");
ok(!W.items.some((x) => x.sourceId === Q_UNK) && /判定できない問い合わせが 1件/.test(src(W, "ec_contact").unknownNote), "事業が分からないものは推測で入れない（数だけ出す）");
r = await get(`?view=work&id=ec_contact:${Q_SITE}`);
ok(r.statusCode === 404, "会社HPの問い合わせを EC として開かない");
r = await get(`?view=work&id=ec_contact:${Q_EC}`);
ok(r.body.view.actions.status.current === "対応中" && kv(r.body.view.fields, "担当メモ") === "見積送付予定" && /返信/.test(r.body.view.actions.replyNote), "状態・担当メモ・返信の仕組みが無いことを出す");
const stamp = r.body.view.actions.status.updatedAt;
r = await post({ action: "contact.update", key: `ec_contact:${Q_EC}`, status: "完了" });
ok(r.statusCode === 400, "知らない状態にはしない");
r = await post({ action: "contact.update", key: `ec_contact:${Q_EC}`, status: "対応済", staffMemo: "見積送付済み", expectUpdatedAt: iso(NOW - 999) });
ok(r.statusCode === 409, "開いたあとに変わっていたら上書きしない");
r = await post({ action: "contact.update", key: `ec_contact:${Q_EC}`, status: "対応済", staffMemo: "見積送付済み", expectUpdatedAt: stamp });
ok(r.statusCode === 200 && mem.rows.contact_submissions.find((x) => x.id === Q_EC).status === "対応済", "状態とメモを更新（8ec の管理画面と同じ更新）");
r = await post({ action: "contact.update", key: `ec_contact:${Q_EC}`, status: "未対応", expectUpdatedAt: stamp });
ok(r.statusCode === 409, "二度目は古い時刻なので上書きしない");
st.zimu = false;
r = await get("?view=work");
ok(src(r.body, "ec_contact").state === "forbidden" && src(r.body, "site_contact").state === "forbidden" && /承認/.test(src(r.body, "site_contact").hint),
  "共有アカウント以外は「権限なし」（追加の権限設定が要ると出す）");
r = await post({ action: "contact.update", key: `site_contact:${Q_SITE}`, status: "対応中" });
ok(r.statusCode === 403, "権限が無ければ更新もできない");
st.zimu = true;

// ================= 既読（押したときだけ・見えるものだけ） =================
r = await post({ action: "read", key: `space_inquiry:${R_NEW}` });
ok(r.statusCode === 200 && mem.rows.gw_marketing_reads.length === 1, "見える原本は既読にできる（中身は写さない）");
ok(Object.keys(mem.rows.gw_marketing_reads[0]).every((k) => ["tenant_id", "source", "source_id", "user_id", "read_at"].includes(k)), "既読の行は種類とIDだけ");
r = await post({ action: "read", key: `mugen_course:${C1}` });
ok(r.statusCode === 200, "受講申込も既読にできる");
r = await get("?view=work");
ok(r.body.items.find((x) => x.sourceId === R_NEW).read === true && r.body.items.find((x) => x.sourceId === R_NEW).status.open, "既読にしても対応待ちのまま");

// ================= 別プロジェクト（この DB に各事業の仕組みが無い） =================
st.missing = true;
r = await get("?view=work");
for (const k of ["space_inquiry", "mugen_course", "ec_contact", "site_contact"]) {
  ok(src(r.body, k).state === "not_connected" && src(r.body, k).count === null && /別の Supabase/.test(src(r.body, k).hint), `${k}：仕組みが無ければ「未連携」（0件ではない）`);
}
st.missing = false;

// ================= マーケティングの利用権限 =================
who = { id: U1, tenant: T1, roles: ["finance"], isAdmin: true, apps: ["office"] };
r = await get("?view=work");
ok(r.statusCode === 403, "Office の権限だけでは、どの事業の問い合わせも見えない");
r = await post({ action: "space.done", key: `space_inquiry:${R_NEW}` });
ok(r.statusCode === 403, "API を直接呼んでも断る");

console.log(`marketing sources API: ${pass} checks passed`);
