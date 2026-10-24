// マーケティング（Office）：各事業の原本を「その人の権限のまま」読む・動かす部品（サーバ側）。方針は docs/office-marketing.md。
//
// ■ 新しい鍵・新しい権限は作らない
//   MF・無限道場（LMS）・8sp・EC・事務ポータルは、同じ Supabase の同じ auth.users を使っている（docs/accounts.md。
//   MF は無限道場の profiles・タイムカードの tc_* を、すでに同じ DB から読んでいる）。
//   なので、ここでは MF にログインしている本人のトークン（userClient）で、各事業の「既存の関数・既存の RLS」を呼ぶ。
//   見えるのは、その人が各事業で元から持っている権限の範囲だけ（8sp の事務・無限道場の講師/管理者・事務の共有アカウント）。
//   service_role（RLS を通らない鍵）は使わない。
//
// ■ 見えない理由を混ぜない
//   ・DB にその事業の関数・表が無い（MF の接続先が別のプロジェクト）… not_connected
//   ・その事業の権限が無い … forbidden（RLS で0行になるのを「0件」と見せないよう、先に権限の関数で確かめる）
//   ・読めなかった … failed
//
// ■ 書き込みは、各事業の既存の処理だけ
//   8sp：対応完了・再開・メモ・予約の承認/却下は 8sp の関数（事務かどうかは関数の中で確かめる）。
//        メールは 8sp のメールAPI（compose → 確認 → send-draft。宛先は 8sp の DB から引く・送信は1通ずつ確保して二重に送らない）
//   問い合わせの表（EC・会社HP）：状態とメモの更新だけ。8ec の管理画面と同じ更新を、同じ RLS（事務の共有アカウント）で
//   無限道場の受講申込：読むだけ（状態を変える既存の画面・関数が無い）

const FN_MISSING = new Set(["PGRST202", "42883"]);
const TABLE_MISSING = new Set(["PGRST205", "42P01", "PGRST106"]);
const isFnMissing = (e) => FN_MISSING.has(String(e?.code || "")) || /could not find the function/i.test(String(e?.message || ""));
const isTableMissing = (e) => TABLE_MISSING.has(String(e?.code || ""))
  || /does not exist|could not find the table|schema must be one of/i.test(String(e?.message || ""));
const chunk = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };
const excerpt = (s, n = 80) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const NOT_HERE = "この DB に、その事業の仕組みがありません（MF の接続先が別の Supabase プロジェクトの可能性があります）";

/** その事業の「権限があるか」の関数を呼ぶ。true / false / 無い（not_connected）/ 失敗 */
export async function probe(sb, fn) {
  let r;
  try { r = await sb.rpc(fn); } catch { return { state: "failed" }; }
  if (r.error) return { state: isFnMissing(r.error) ? "not_connected" : "failed" };
  return { state: r.data === true ? "ok" : "forbidden" };
}

// ================================================================================================
// スペース（8sp）：お問い合わせ（rental_records）と予約（space_bookings）
// ================================================================================================
export const SPACE_CLOSED = ["対応完了", "キャンセル"];
const SPACE_KEEP_CLOSED_DAYS = 60;
export const SPACE_LIMIT = 300;
// 8sp の管理画面（member/admin.html）の「次にすること」と同じ言い方
export function spaceNext(r) {
  const st = r.guide_status || "新規";
  if (st === "新規") return "案内メールを作成 → 内容を確認 → 送信";
  if (SPACE_CLOSED.includes(st)) return "";
  if (r.booking_state === "仮予約") return "仮予約の内容を確認して、承認するか決める";
  return "会員登録・予約の進み具合を確認";
}
const BOOKING_LABEL = { tentative: "仮予約", confirmed: "確定", done: "利用済み", cancelled: "キャンセル", rejected: "却下" };

export async function readSpace(sb, { now = Date.now() } = {}) {
  const p = await probe(sb, "space_is_staff");
  if (p.state === "not_connected") return { state: "not_connected", hint: NOT_HERE };
  if (p.state === "forbidden") return { state: "forbidden", hint: "8sp の事務権限（事務の共有アカウント、または 8sp で有効な管理者）がある人だけが見られます" };
  if (p.state !== "ok") return { state: "failed", hint: "8sp の権限を確かめられませんでした" };
  const { data, error } = await sb.rpc("space_inquiry_admin_list");
  if (error) return { state: isFnMissing(error) ? "not_connected" : "failed", hint: isFnMissing(error) ? NOT_HERE : "8sp のお問い合わせを読めませんでした" };
  const since = now - SPACE_KEEP_CLOSED_DAYS * 86400000;
  const all = (data || []).filter((r) => !SPACE_CLOSED.includes(r.guide_status || "新規")
    || Date.parse(r.created_at || 0) >= since);
  const rows = all.slice(0, SPACE_LIMIT);
  // 担当（事務ポータルの「担当」＝自由記述）と営業の状態は、一覧の関数に無いので、同じ権限で表から読む
  const extra = new Map();
  let extraOk = true;
  for (const ids of chunk(rows.map((r) => r.id), 150)) {
    const { data: ex, error: e2 } = await sb.from("rental_records").select("id, staff, status, booking_group_id, updated_at").in("id", ids);
    if (e2) { extraOk = false; break; }
    for (const x of ex || []) extra.set(x.id, x);
  }
  return { state: "ok", rows, extra: extraOk ? extra : null, capped: all.length > SPACE_LIMIT, limit: SPACE_LIMIT };
}

export function spaceItem(r, extra, reads, now) {
  const x = extra ? extra.get(r.id) : null;
  const st = r.guide_status || "新規";
  const isInquiry = r.kind === "問い合わせ";
  return {
    key: `space_inquiry:${r.id}`, source: "space_inquiry", sourceId: r.id, biz: "space",
    kind: isInquiry ? "inquiry" : "booking", typeLabel: r.kind || "予約",
    from: [r.person, r.org].filter(Boolean).join("（") + (r.org && r.person ? "）" : ""),
    subject: r.purpose || (isInquiry ? "お問い合わせ" : "予約の申込"),
    points: [r.wish && `希望：${r.wish}`, r.headcount != null && `${r.headcount}名`, r.source && `経路：${r.source}`,
      r.booking_state && `予約：${r.booking_state}`].filter(Boolean),
    quote: excerpt(r.form_content),
    receivedAt: r.created_at || (r.recv_date ? `${r.recv_date}T00:00:00+09:00` : null),
    isNew: Boolean(r.created_at) && now - Date.parse(r.created_at) < 24 * 3600000,
    owner: x ? (x.staff ? { id: null, name: x.staff, free: true } : null) : undefined,
    status: { key: st, label: st, open: !SPACE_CLOSED.includes(st) },
    next: spaceNext(r),
    due: null,
    read: reads.ready ? reads.set.has(r.id) : null,
    href: "https://8sp.jp/member/admin.html",
    canReply: Boolean(String(r.email || "").trim()),
    updatedAt: x?.updated_at || null,
  };
}

const RECORD_FIELDS = "id, kind, name, contact_person, email, phone, source, recv_date, use_date, use_end, use_time, headcount, "
  + "purpose, form_content, staff, status, guide_status, booking_group_id, member_id, created_at, updated_at";

/** 1件の詳細（送信者・本文・予約内容・対応履歴・担当・次の対応）。読むだけ */
export async function spaceDetail(sb, id) {
  const p = await probe(sb, "space_is_staff");
  if (p.state !== "ok") return { status: p.state === "forbidden" ? 403 : p.state === "not_connected" ? 503 : 500, error: p.state };
  const { data: r, error } = await sb.from("rental_records").select(RECORD_FIELDS).eq("id", id).maybeSingle();
  if (error) return { status: isTableMissing(error) ? 503 : 500, error: "read_failed" };
  if (!r) return { status: 404, error: "not_found" };
  const safe = async (q) => { try { const x = await q; return x.error ? null : (x.data || []); } catch { return null; } };
  const [events, notes, mails, bookings] = await Promise.all([
    safe(sb.rpc("space_inquiry_events_of", { p_record_id: id })),
    safe(sb.rpc("space_inquiry_notes_of", { p_record_id: id })),
    safe(sb.rpc("space_mail_log_of", { p_record_id: id })),
    r.booking_group_id
      ? safe(sb.from("space_bookings").select("id, starts_at, ends_at, purpose, headcount, status, amount, admin_comment, updated_at")
        .eq("group_id", r.booking_group_id).order("starts_at"))
      : Promise.resolve([]),
  ]);
  return { status: 200, row: r, events, notes, mails, bookings };
}

export function spaceDetailView(d, item) {
  const r = d.row;
  const person = (r.contact_person || "").trim() || (r.name || "").trim();
  const org = (r.contact_person || "").trim() ? (r.name || "").trim() : "";
  const wish = [r.use_date && `${r.use_date}${r.use_end && r.use_end !== r.use_date ? `〜${r.use_end}` : ""}`, r.use_time].filter(Boolean).join(" ");
  const history = [
    ...(d.events || []).map((e) => ({ at: e.at, label: e.kind, detail: e.detail || null, who: e.actor_name || null, kind: "event" })),
    ...(d.notes || []).filter((n) => n.same_record !== false).map((n) => ({ at: n.at, label: n.important ? "メモ（重要）" : "メモ", detail: n.body, who: n.author_name || null, kind: "note" })),
    ...(d.mails || []).map((m) => ({ at: m.sent_at || m.at, label: `メール：${m.subject || m.kind || ""}`, detail: `${m.status || ""}${m.to_email ? `・宛先 ${m.to_email}` : ""}`, who: m.sender_name || null, kind: "mail" })),
  ].sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  return {
    contact: [["お名前", person], ["会社名", org], ["メール", r.email], ["電話", r.phone], ["経路", r.source]].filter(([, v]) => v),
    body: { label: "お問い合わせの内容（原文）", text: r.form_content || "" },
    fields: [["種類", r.kind || "予約"], ["利用目的", r.purpose], ["希望日時", wish], ["人数", r.headcount != null ? `${r.headcount}名` : null],
      ["受付日", r.recv_date], ["8sp の進み具合", r.guide_status || "新規"], ["営業の状態（事務ポータル）", r.status]].filter(([, v]) => v),
    bookings: d.bookings == null ? null : d.bookings.map((b) => ({
      id: b.id, startsAt: b.starts_at, endsAt: b.ends_at, purpose: b.purpose || "", headcount: b.headcount,
      status: b.status, statusLabel: BOOKING_LABEL[b.status] || b.status, amount: b.amount, comment: b.admin_comment || null,
      canDecide: b.status === "tentative",
    })),
    history: d.events == null && d.notes == null && d.mails == null ? null : history,
    owner: r.staff ? { name: r.staff, from: "事務ポータルの担当（自由記述）" } : null,
    ownerNote: r.staff ? null : "担当は未設定（事務ポータルの担当欄）",
    next: item?.next ?? spaceNext({ guide_status: r.guide_status }),
    due: null, dueNote: "期限は原本に項目がありません",
    actions: {
      note: true,
      done: !SPACE_CLOSED.includes(r.guide_status || "新規"),
      reopen: SPACE_CLOSED.includes(r.guide_status || "新規"),
      reply: Boolean(String(r.email || "").trim()),
    },
  };
}

// 8sp の関数で書く（事務かどうかは関数の中で確かめる。MF からは本人のトークンで呼ぶだけ）
export async function spaceCall(sb, fn, args) {
  const { data, error } = await sb.rpc(fn, args);
  if (!error) return { ok: true, data };
  const msg = String(error.message || "");
  if (/forbidden/.test(msg) || error.code === "42501") return { ok: false, status: 403, error: "forbidden", message: "8sp の事務権限がありません" };
  if (/not_found/.test(msg)) return { ok: false, status: 404, error: "not_found", message: "8sp に見つかりません" };
  if (/comment_required/.test(msg)) return { ok: false, status: 400, error: "comment_required", message: "却下するときは、理由（コメント）を書いてください" };
  if (/body_required/.test(msg)) return { ok: false, status: 400, error: "body_required", message: "メモを書いてください" };
  if (isFnMissing(error)) return { ok: false, status: 503, error: "not_connected", message: NOT_HERE };
  // 8sp の見張り（予約の重なり・状態の順番）が止めたときは、その言葉をそのまま出す
  return { ok: false, status: 409, error: "rejected_by_8sp", message: msg.slice(0, 300) || "8sp が受け付けませんでした" };
}

/**
 * 8sp のメールAPI（https://8sp.jp/api/send-mail 等。SPACE_MAIL_API_URL）を、本人のトークンのまま呼ぶ。
 * 宛先は 8sp が DB から引く（ここからは渡さない）。compose は下書きを1通作って見せる、send-draft はその1通だけを送る
 */
export async function spaceMail({ url, token, payload, fetchImpl = fetch, timeoutMs = 15000 }) {
  if (!url) return { ok: false, status: 503, error: "mail_not_configured", message: "8sp のメールAPIの場所（SPACE_MAIL_API_URL）が未設定のため、ここからは送れません" };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { method: "POST", signal: ctl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
    let b = null;
    try { b = await r.json(); } catch { b = null; }
    if (r.ok && b && b.ok !== false) return { ok: true, status: 200, body: b };
    return { ok: false, status: r.status === 401 || r.status === 403 ? 403 : 400, error: "rejected_by_8sp",
      message: String(b?.message || b?.error || `8sp が受け付けませんでした（${r.status}）`).slice(0, 300), body: b };
  } catch {
    // 時間切れ・通信の失敗：送れたかどうか分からない。すぐに送り直さない（8sp のメール履歴で確かめる）
    return { ok: false, status: 202, error: "unknown", message: "8sp からの応答がありません。送れたかどうか分からないので、すぐに送り直さず、8sp のメール履歴で確かめてください" };
  } finally {
    clearTimeout(t);
  }
}

// ================================================================================================
// 無限道場：講座の受講申込（lms.course_applications）
// ================================================================================================
export const COURSE_STATUS = { new: "未対応", contacted: "連絡済", processing: "手続き中", enrolled: "受講決定", declined: "見送り" };
const COURSE_CLOSED = ["enrolled", "declined"];
const COURSE_FIELDS = "id, course, name, kana, email, tel, style, motivation, applicant, org, dept, note, status, created_at, updated_at";
const COURSE_FIELDS_OLD = "id, course, name, kana, email, tel, style, motivation, note, status, created_at, updated_at";

export async function readCourse(sb) {
  const p = await probe(sb, "is_lms_staff");
  if (p.state === "not_connected") return { state: "not_connected", hint: NOT_HERE };
  if (p.state === "forbidden") return { state: "forbidden", hint: "無限道場の講師・管理者の権限がある人だけが見られます" };
  if (p.state !== "ok") return { state: "failed", hint: "無限道場の権限を確かめられませんでした" };
  const q = (fields) => sb.schema("lms").from("course_applications").select(fields).order("created_at", { ascending: false }).limit(301);
  let { data, error } = await q(COURSE_FIELDS);
  // 法人の列（course-applications-org.sql）が未適用の DB でも、ほかの項目は読む
  if (error && String(error.code) === "42703") ({ data, error } = await q(COURSE_FIELDS_OLD));
  if (error) return { state: isTableMissing(error) ? "not_connected" : "failed", hint: isTableMissing(error) ? NOT_HERE : "受講申込を読めませんでした" };
  return { state: "ok", rows: (data || []).slice(0, 300), capped: (data || []).length > 300, limit: 300 };
}

export function courseItem(a, reads, now) {
  return {
    key: `mugen_course:${a.id}`, source: "mugen_course", sourceId: a.id, biz: "mugen", kind: "inquiry",
    typeLabel: a.applicant === "法人" ? "受講申込（法人）" : "受講申込",
    from: a.org ? `${a.name}（${a.org}）` : a.name,
    subject: a.course || "講座の受講申込",
    points: [a.applicant && `申込：${a.applicant}`, a.style && `参加方法：${a.style}`, a.dept && `部署：${a.dept}`].filter(Boolean),
    quote: excerpt(a.motivation),
    receivedAt: a.created_at,
    isNew: Boolean(a.created_at) && now - Date.parse(a.created_at) < 24 * 3600000,
    owner: null, ownerMissing: true,
    status: { key: a.status, label: COURSE_STATUS[a.status] || a.status, open: !COURSE_CLOSED.includes(a.status) },
    next: "",
    due: null,
    read: reads.ready ? reads.set.has(a.id) : null,
    href: "https://mugendojo.jp/mgn/admin/applications",
    canReply: false,
    updatedAt: a.updated_at,
  };
}

export function courseDetailView(a) {
  return {
    contact: [["お名前", a.name], ["ふりがな", a.kana], ["会社・団体", a.org], ["部署", a.dept], ["メール", a.email], ["電話", a.tel]].filter(([, v]) => v),
    body: { label: "受講で実現したいこと（原文）", text: a.motivation || "" },
    fields: [["講座", a.course], ["申込", a.applicant], ["参加方法", a.style], ["状態", COURSE_STATUS[a.status] || a.status], ["運営メモ", a.note]].filter(([, v]) => v),
    bookings: [],
    history: [{ at: a.created_at, label: "受講申込", detail: null, who: null, kind: "event" },
      ...(a.updated_at && a.updated_at !== a.created_at ? [{ at: a.updated_at, label: "最後の更新", detail: null, who: null, kind: "event" }] : [])],
    owner: null, ownerNote: "担当は原本に項目がありません",
    next: "", nextNote: "次の対応は原本に項目がありません",
    due: null, dueNote: "期限は原本に項目がありません",
    actions: { note: false, done: false, reopen: false, reply: false,
      readOnlyNote: "無限道場には、受講申込の状態を変える画面・関数がまだありません。ここでは読むだけです" },
  };
}

export async function courseOne(sb, id) {
  const p = await probe(sb, "is_lms_staff");
  if (p.state !== "ok") return { status: p.state === "forbidden" ? 403 : p.state === "not_connected" ? 503 : 500, error: p.state };
  let { data, error } = await sb.schema("lms").from("course_applications").select(COURSE_FIELDS).eq("id", id).maybeSingle();
  if (error && String(error.code) === "42703") ({ data, error } = await sb.schema("lms").from("course_applications").select(COURSE_FIELDS_OLD).eq("id", id).maybeSingle());
  if (error) return { status: 500, error: "read_failed" };
  if (!data) return { status: 404, error: "not_found" };
  return { status: 200, row: data };
}

// ================================================================================================
// EC・会社ホームページ：問い合わせの表（contact_submissions）
// ================================================================================================
export const CONTACT_STATUSES = ["未対応", "対応中", "対応済"];
// 送信元ページ（source）で事業を分ける。分からない値は推測しない（数だけ出す）
// 8ec.jp の api/contact.js に届く送信元。buy は buy.html（中古PCの購入相談）。rent.html は top で届く
const EC_SOURCES = ["top", "pc", "cloud", "ai-dev", "company", "buy", "general"];
export const contactBiz = (source) => (source === "8grp_lp" ? "site" : EC_SOURCES.includes(source) ? "ec" : null);
const CONTACT_FIELDS = "id, source, inquiry_type, name, company, email, phone, message, status, staff_memo, created_at, updated_at";

export async function readContact(sb) {
  const p = await probe(sb, "zimu_is_admin");
  if (p.state === "not_connected") return { state: "not_connected", hint: NOT_HERE };
  if (p.state === "forbidden") {
    return { state: "forbidden", hint: "この問い合わせの表は、事務の共有アカウント（zimu）でログインした人だけが読めます。"
      + "担当者が自分のアカウントで見るには、表の権限の追加（承認が必要）が要ります" };
  }
  if (p.state !== "ok") return { state: "failed", hint: "権限を確かめられませんでした" };
  const { data, error } = await sb.from("contact_submissions").select(CONTACT_FIELDS).order("created_at", { ascending: false }).limit(301);
  if (error) return { state: isTableMissing(error) ? "not_connected" : "failed", hint: isTableMissing(error) ? NOT_HERE : "問い合わせを読めませんでした" };
  const rows = (data || []).slice(0, 300);
  const unknown = rows.filter((r) => !contactBiz(r.source));
  return { state: "ok", rows, capped: (data || []).length > 300, limit: 300,
    unknown: { count: unknown.length, sources: [...new Set(unknown.map((r) => r.source || "（空）"))].slice(0, 5) } };
}

export function contactItem(c, reads, now) {
  const biz = contactBiz(c.source);
  return {
    key: `${biz === "site" ? "site_contact" : "ec_contact"}:${c.id}`, source: biz === "site" ? "site_contact" : "ec_contact",
    sourceId: c.id, biz, kind: "inquiry", typeLabel: c.inquiry_type || "問い合わせ",
    from: c.company ? `${c.name}（${c.company}）` : c.name,
    subject: c.inquiry_type || "お問い合わせ",
    points: [c.source && `ページ：${c.source}`].filter(Boolean),
    quote: excerpt(c.message),
    receivedAt: c.created_at,
    isNew: Boolean(c.created_at) && now - Date.parse(c.created_at) < 24 * 3600000,
    owner: null, ownerMissing: true,
    status: { key: c.status || "未対応", label: c.status || "未対応", open: (c.status || "未対応") !== "対応済" },
    next: "",
    due: null,
    read: reads.ready ? reads.set.has(c.id) : null,
    href: "https://8ec.jp/admin/contact/",
    canReply: false,
    updatedAt: c.updated_at,
  };
}

export function contactDetailView(c) {
  return {
    contact: [["お名前", c.name], ["会社名", c.company], ["メール", c.email], ["電話", c.phone], ["送信元ページ", c.source]].filter(([, v]) => v),
    body: { label: "お問い合わせの内容（原文）", text: c.message || "" },
    fields: [["種別", c.inquiry_type], ["状態", c.status || "未対応"], ["担当メモ", c.staff_memo]].filter(([, v]) => v),
    bookings: [],
    history: [{ at: c.created_at, label: "受付", detail: null, who: null, kind: "event" },
      ...(c.updated_at && c.updated_at !== c.created_at ? [{ at: c.updated_at, label: "最後の更新", detail: null, who: null, kind: "event" }] : [])],
    owner: null, ownerNote: "担当は原本に項目がありません（担当メモはあります）",
    next: "", nextNote: "次の対応は原本に項目がありません",
    due: null, dueNote: "期限は原本に項目がありません",
    actions: { note: false, done: false, reopen: false, reply: false,
      status: { options: CONTACT_STATUSES, current: c.status || "未対応", memo: c.staff_memo || "", updatedAt: c.updated_at },
      replyNote: "この問い合わせの返信は、既存の仕組みにメール送信がありません（返信はメールソフトから）" },
  };
}

export async function contactOne(sb, id) {
  const p = await probe(sb, "zimu_is_admin");
  if (p.state !== "ok") return { status: p.state === "forbidden" ? 403 : p.state === "not_connected" ? 503 : 500, error: p.state };
  const { data, error } = await sb.from("contact_submissions").select(CONTACT_FIELDS).eq("id", id).maybeSingle();
  if (error) return { status: 500, error: "read_failed" };
  if (!data) return { status: 404, error: "not_found" };
  return { status: 200, row: data };
}

/** 状態とメモだけを更新（8ec の管理画面と同じ更新。同じ RLS）。開いたあとに誰かが直していたら 409 */
export async function contactUpdate(sb, id, { status, staffMemo, expectUpdatedAt }) {
  if (status != null && !CONTACT_STATUSES.includes(status)) return { status: 400, error: "invalid_status" };
  if (staffMemo != null && String(staffMemo).length > 2000) return { status: 400, error: "memo_too_long" };
  const p = await probe(sb, "zimu_is_admin");
  if (p.state !== "ok") return { status: p.state === "forbidden" ? 403 : 503, error: p.state };
  const patch = { updated_at: new Date().toISOString() };
  if (status != null) patch.status = status;
  if (staffMemo != null) patch.staff_memo = String(staffMemo);
  let q = sb.from("contact_submissions").update(patch).eq("id", id);
  if (expectUpdatedAt) q = q.eq("updated_at", expectUpdatedAt);
  const { data, error } = await q.select("id, status, staff_memo, updated_at").maybeSingle();
  if (error) return { status: 500, error: "write_failed" };
  if (!data) return { status: 409, error: "changed", message: "開いたあとで、ほかの人が更新しました。開き直してください" };
  return { status: 200, row: data };
}
