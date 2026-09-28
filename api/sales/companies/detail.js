// GET   /api/sales/companies/detail?id=…   … 企業1社ぶん（営業履歴・直近アタックの警告つき）
// PATCH /api/sales/companies/detail { id, ... }
//         … 企業本体を更新（基本情報・ステータス・NEXT・担当・NG）
//         { id, action: "followed" } … クリックに対応した（未対応クリックから外す）
// POST  /api/sales/companies/detail { id, kind, detail?, occurredAt? }
//         … 営業履歴に出来事を足す（フォロー・電話・メール・返信あり・商談・メモ）
// POST  /api/sales/companies/detail { id, action: "contact", replied, replyChannel?, contactChannel?,
//                                     contacts?, note?, occurredAt?, nextAction?, nextActionOn? }
//         … 「返信・やり取りを記録」（db/096）。返信元チャネル・いまの連絡手段・連絡先・メモ・NEXT
//
// ■ 営業履歴は3つの表から時系列に混ぜて出す
//   アタック（gw_sales_approaches）・クリック（gw_sales_click_events）・
//   それ以外の出来事（gw_sales_events）。同じことを2か所に書かない。
//
// ■ ステータスと連絡手段は別
//   連絡手段を変えただけでは、営業ステータスは動かさない。
//   「先方から返信があった」を記録したときだけ、ほかの返信記録と同じく「返信あり」まで進める。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell, canForceAttack } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import {
  COMPANY_FIELDS, normalizeCompany, shapeCompany, shapeApproach, aggregateApproaches, nextFor, hasUnhandledClick,
  recentApproach, statusRank, todayJst, isUuid, autoNext,
  STATUSES, STATUS_LABEL, NG_REASONS, EVENT_KINDS, EVENT_LABEL, EVENT_ADVANCES, SERVICES, INDUSTRIES, RECENT_DAYS,
  SEND_CHANNELS, REPLY_CHANNELS, CONTACT_CHANNELS, REPLY_CHANNEL_KEYS, CONTACT_CHANNEL_KEYS, HIDE_REASONS,
  SEND_FAIL_REASONS, channelLabel, normalizeContacts, mergeContacts,
} from "../../../lib/sales.js";
import { MEETING_FIELDS, shapeMeeting } from "../../../lib/sales-meetings.js";

const SQL = "db/088_sales.sql・db/096_sales_channels.sql";
// 「最終連絡」に数えない出来事（こちらの記録の整理で、相手とのやり取りではないもの）
const NOT_CONTACT = new Set(["status", "memo", "next", "hide"]);

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);

  if (req.method === "GET") return one(req, res, sb, ctx);
  if (req.method === "PATCH") return update(req, res, sb, ctx, user);
  if (req.method === "POST") return addEvent(req, res, sb, ctx, user);
  return methodNotAllowed(res, ["GET", "PATCH", "POST"]);
}

async function loadCompany(sb, ctx, id) {
  const { data, error } = await sb.from("gw_sales_companies").select(COMPANY_FIELDS)
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
  return { company: data || null, error };
}

async function one(req, res, sb, ctx) {
  const id = new URL(req.url, "http://localhost").searchParams.get("id");
  if (!isUuid(id)) return json(res, 400, { error: "invalid_query", required: ["id"] });

  const { company: c, error } = await loadCompany(sb, ctx, id);
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }
  if (!c) return json(res, 404, { error: "not_found" });

  const [{ data: approaches }, { data: clicks }, { data: events }, { data: members }, { data: campaigns }, { data: meetings }] = await Promise.all([
    sb.from("gw_sales_approaches")
      .select("id, company_id, campaign_id, template_id, employee_id, service, subject, body, form_url, "
        + "tracking_token, destination_url, prepared_at, sent_at, forced, first_click_at, last_click_at, click_count, "
        + "channel, send_from, failed_at, send_failed_reason, send_failed_note")
      .eq("company_id", id).order("prepared_at", { ascending: false }).limit(200),
    sb.from("gw_sales_click_events").select("id, approach_id, clicked_at, click_no")
      .eq("company_id", id).eq("is_valid", true).order("clicked_at", { ascending: false }).limit(300),
    sb.from("gw_sales_events").select("id, event_key, label, detail, occurred_at, employee_id, channel")
      .eq("company_id", id).order("occurred_at", { ascending: true }).limit(500),
    sb.from("gw_employees").select("id, display_name")
      .eq("tenant_id", ctx.tenantId).in("status", ["active", "invited"]).order("display_name").limit(300),
    sb.from("gw_sales_campaigns").select("id, name, archived_at").eq("tenant_id", ctx.tenantId).limit(500),
    // 面談（db/090）。まだ表が無い環境でも企業詳細は開けるようにする（エラーは空として扱う）
    sb.from("gw_sales_meetings").select(MEETING_FIELDS).eq("company_id", id).order("created_at", { ascending: false }).limit(50),
  ]);
  const name = new Map((members || []).map((e) => [e.id, e.display_name]));
  const today = todayJst();
  const agg = aggregateApproaches(approaches).get(id) || null;
  const next = nextFor(c, agg, today);
  const recent = recentApproach(approaches);

  const sent = (approaches || []).filter((a) => a.sent_at || a.click_count > 0);
  const failed = (approaches || []).filter((a) => a.failed_at && !a.sent_at);
  const timeline = [
    ...sent.map((a) => ({
      at: a.sent_at || a.prepared_at, kind: "attack",
      label: a.sent_at ? `${channelLabel(a.channel || "form")}から送信` : "専用URL発行（送信完了が未記録）",
      detail: [a.send_from, a.service, name.get(a.employee_id)].filter(Boolean).join(" ／ ") || null,
      approachId: a.id, channel: a.channel || "form",
    })),
    // 送信できなかったことも営業結果として残す（別チャネルで再アタックするかの判断材料）
    ...failed.map((a) => {
      const s = shapeApproach(a);
      return {
        at: a.failed_at, kind: "attack_failed",
        label: `送信できず：${s.failedLabel}${(a.channel || "form") !== "form" ? `（${s.channelLabel}）` : ""}`,
        detail: [a.send_failed_note, name.get(a.employee_id)].filter(Boolean).join(" ／ ") || null,
        approachId: a.id, channel: a.channel || "form",
      };
    }),
    ...(clicks || []).map((k) => ({
      at: k.clicked_at, kind: "click",
      label: (k.click_no || 1) > 1 ? `リンク再クリック（${k.click_no}回目）` : "リンククリック",
      detail: null, approachId: k.approach_id,
    })),
    ...(events || []).map((e) => ({
      at: e.occurred_at, kind: e.event_key, label: e.label, channel: e.channel || null,
      detail: [e.detail, name.get(e.employee_id)].filter(Boolean).join(" ／ ") || null,
    })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));

  // 現在の連絡状況（要件 §10）：最初に送ったチャネル・返信元・いまの連絡手段・最終連絡・担当
  const firstSent = (approaches || []).filter((a) => a.sent_at)
    .sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)))[0] || null;
  const lastReply = (events || []).filter((e) => e.event_key === "reply" && e.channel)
    .sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)))[0] || null;
  const lastContactAt = [
    c.last_contact_at,
    ...(approaches || []).map((a) => a.sent_at),
    ...(events || []).filter((e) => !NOT_CONTACT.has(e.event_key)).map((e) => e.occurred_at),
  ].filter(Boolean).sort().pop() || null;
  const contactStatus = {
    firstChannel: firstSent ? firstSent.channel || "form" : null,
    firstChannelLabel: firstSent ? channelLabel(firstSent.channel || "form") : null,
    firstSentAt: firstSent?.sent_at || null,
    replyChannel: lastReply?.channel || null,
    replyChannelLabel: lastReply ? REPLY_CHANNELS.find((r) => r.key === lastReply.channel)?.label || channelLabel(lastReply.channel) : null,
    currentChannel: c.current_contact_channel || null,
    currentChannelLabel: channelLabel(c.current_contact_channel),
    currentValue: c.current_contact_value || null,
    lastContactAt,
  };
  if (c.next_action_on && !["won", "lost", "excluded"].includes(c.status)) {
    timeline.push({ at: `${c.next_action_on}T00:00:00+09:00`, kind: "next", planned: true,
      label: `${c.next_action || "NEXT"}（予定）`, detail: null });
  }

  return json(res, 200, {
    today,
    company: {
      ...shapeCompany(c),
      ownerName: name.get(c.owner_id) || null,
      campaignName: (campaigns || []).find((x) => x.id === c.campaign_id)?.name || null,
      clickCount: agg?.clickCount || 0,
      firstClickAt: agg?.first_click_at || null,
      lastClickAt: agg?.last_click_at || null,
      unhandledClick: hasUnhandledClick(c, agg),
      next: next.label, nextKey: next.key, nextDue: next.due, overdue: next.overdue,
    },
    approaches: sent.map((a) => ({ ...shapeApproach(a), employeeName: name.get(a.employee_id) || null })),
    failedApproaches: failed.map((a) => ({ ...shapeApproach(a), body: undefined, employeeName: name.get(a.employee_id) || null })),
    contactStatus,
    meetings: (meetings || []).map((m) => shapeMeeting(m, (eid) => name.get(eid))),
    meetingsReady: meetings !== null && meetings !== undefined,
    timerexConfigured: Boolean((process.env.TIMEREX_SALES_MEETING_URL || "").trim()),
    timeline,
    // 直近アタックの警告（要件 §20）。企業ページにも、フォームアタックを押したときにも出す
    recent: recent ? {
      sentAt: recent.sent_at, employeeName: name.get(recent.employee_id) || null,
      service: recent.service || null, days: RECENT_DAYS,
      channel: recent.channel || "form", channelLabel: channelLabel(recent.channel || "form"),
    } : null,
    canForce: canForceAttack(ctx),
    members: members || [],
    campaigns: (campaigns || []).filter((x) => !x.archived_at).map((x) => ({ id: x.id, name: x.name })),
    // 画面側で項目を持たない（ここが正）
    statuses: STATUSES, ngReasons: NG_REASONS, eventKinds: EVENT_KINDS, services: SERVICES, industries: INDUSTRIES,
    sendChannels: SEND_CHANNELS, replyChannels: REPLY_CHANNELS, contactChannels: CONTACT_CHANNELS,
    hideReasons: HIDE_REASONS, sendFailReasons: SEND_FAIL_REASONS,
  });
}

async function update(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!isUuid(body.id)) return json(res, 400, { error: "invalid_body", required: ["id"] });

  const { company: before, error: e0 } = await loadCompany(sb, ctx, body.id);
  if (e0) {
    const hint = dbSetupHint(e0, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: e0.message });
  }
  if (!before) return json(res, 404, { error: "not_found" });

  let patch;
  if (body.action === "followed") {
    patch = { followed_at: new Date().toISOString() };
  } else {
    const row = normalizeCompany(body, { partial: true });
    if (row.error) return json(res, 400, row);
    patch = row.value;
    // 返信あり・商談へ手で進めたときも、NEXT を決めていなければ自動で入れる
    // 空欄（null・""）は「決めていない」。画面のフォームは空欄を null で送ってくる
    const nextGiven = Boolean(patch.next_action || patch.next_action_on);
    if (patch.status && patch.status !== before.status && !nextGiven) {
      if (patch.status === "replied") Object.assign(patch, autoNext("reply"));
      if (patch.status === "meeting") Object.assign(patch, autoNext("meeting"));
    }
    if (patch.domain && patch.domain !== before.domain) {
      const { data: dup } = await sb.from("gw_sales_companies").select("id, name")
        .eq("tenant_id", ctx.tenantId).eq("domain", patch.domain).limit(2);
      const other = (dup || []).find((d) => d.id !== before.id);
      if (other) return json(res, 409, { error: "duplicate", company: other, hint: `同じサイトの企業が登録済みです（${other.name}）` });
    }
  }
  if (!Object.keys(patch).length) return json(res, 400, { error: "nothing_to_update" });
  patch.updated_at = new Date().toISOString();

  const { data, error } = await sb.from("gw_sales_companies").update(patch)
    .eq("id", before.id).eq("tenant_id", ctx.tenantId).select(COMPANY_FIELDS).single();
  if (error) {
    if (error.code === "23505") return json(res, 409, { error: "duplicate", hint: "同じサイトの企業が登録済みです" });
    return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
  }

  // 営業履歴に残すのは、状態・NGが変わったときだけ（基本情報の直しは監査ログだけ）
  const logs = [];
  if (patch.status && patch.status !== before.status) {
    logs.push({ event_key: "status", label: `ステータス：${STATUS_LABEL[patch.status]}`,
      detail: `${STATUS_LABEL[before.status] || before.status} → ${STATUS_LABEL[patch.status]}` });
  }
  if ("ng_reason" in patch && patch.ng_reason !== before.ng_reason) {
    logs.push(patch.ng_reason
      ? { event_key: "status", label: "営業禁止に設定", detail: patch.ng_note || before.ng_note || null }
      : { event_key: "status", label: "営業禁止を解除", detail: null });
  }
  if (logs.length) {
    await sb.from("gw_sales_events").insert(logs.map((l) => ({
      ...l, tenant_id: ctx.tenantId, company_id: before.id,
      employee_id: ctx.employee?.id || null, created_by: user.id,
    })));
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: body.action === "followed" ? "sales.click_followed" : "sales.company_update",
    target: `sales_company:${before.id}`, detail: { fields: Object.keys(patch).filter((k) => k !== "updated_at") },
  });
  return json(res, 200, { company: shapeCompany(data) });
}

async function addEvent(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (body.action === "contact") return addContact(res, sb, ctx, user, body);
  if (!isUuid(body.id)) return json(res, 400, { error: "invalid_body", required: ["id", "kind"] });
  if (!EVENT_LABEL[body.kind]) return json(res, 400, { error: "bad_kind", allowed: Object.keys(EVENT_LABEL) });

  const { company: c, error: e0 } = await loadCompany(sb, ctx, body.id);
  if (e0) {
    const hint = dbSetupHint(e0, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: e0.message });
  }
  if (!c) return json(res, 404, { error: "not_found" });

  let occurredAt = new Date().toISOString();
  if (body.occurredAt) {
    const d = new Date(body.occurredAt);
    if (Number.isNaN(d.getTime())) return json(res, 400, { error: "bad_date" });
    occurredAt = d.toISOString();
  }
  const detail = body.detail ? String(body.detail).trim().slice(0, 2000) || null : null;

  const { error } = await sb.from("gw_sales_events").insert({
    tenant_id: ctx.tenantId, company_id: c.id, event_key: body.kind, label: EVENT_LABEL[body.kind],
    detail, occurred_at: occurredAt, employee_id: ctx.employee?.id || null, created_by: user.id,
  });
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });

  // メモ以外は「反応に対応した」ことになる。返信・商談はステータスも進める（後ろへは戻さない）
  const patch = {};
  if (body.kind !== "memo") patch.followed_at = new Date().toISOString();
  if (body.kind !== "memo" && (!c.last_contact_at || occurredAt > c.last_contact_at)) patch.last_contact_at = occurredAt;
  const to = EVENT_ADVANCES[body.kind];
  if (to && statusRank(to) > statusRank(c.status)) patch.status = to;
  // NEXT：その場で決めたものが優先。決めなければ反応に応じて自動で入れる
  //   返信あり → 返信対応（当日）／商談 → 商談準備（当日）／フォロー・電話・メール → 反応確認（3営業日後）
  //   ただし返信・商談中の会社にフォローを記録しても、返信対応・商談準備は上書きしない
  const nextGiven = (body.nextAction !== undefined && body.nextAction !== null && body.nextAction !== "")
    || (body.nextActionOn !== undefined && body.nextActionOn !== null && body.nextActionOn !== "");
  if (nextGiven) {
    const n = normalizeCompany({ nextAction: body.nextAction, nextActionOn: body.nextActionOn }, { partial: true });
    if (n.error) return json(res, 400, n);
    Object.assign(patch, n.value);
  } else if (body.kind === "reply" || body.kind === "meeting") {
    if (statusRank(c.status) <= statusRank(to)) Object.assign(patch, autoNext(body.kind));
  } else if (["follow", "call", "mail"].includes(body.kind) && statusRank(c.status) < statusRank("replied")) {
    Object.assign(patch, autoNext("follow"));
  }
  let company = c;
  if (Object.keys(patch).length) {
    patch.updated_at = new Date().toISOString();
    const { data } = await sb.from("gw_sales_companies").update(patch)
      .eq("id", c.id).eq("tenant_id", ctx.tenantId).select(COMPANY_FIELDS).single();
    if (data) company = data;
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "sales.event_add",
    target: `sales_company:${c.id}`, detail: { kind: body.kind },
  });
  return json(res, 200, { company: shapeCompany(company) });
}

/**
 * 返信・やり取りを記録（要件 §4〜§9）。
 *   replied=true  … 先方から返信があった。返信元チャネルは必須。ステータスを「返信あり」まで進める
 *   replied=false … こちらからの連絡・やり取り（資料送付・日程調整など）。ステータスは動かさない
 * どちらでも、いまの連絡手段・連絡先・メモ・NEXT を一緒に保存できる。
 * 営業履歴には「先方返信：Instagram」「連絡手段をメールへ切替」のように分けて残す。
 */
async function addContact(res, sb, ctx, user, body) {
  if (!isUuid(body.id)) return json(res, 400, { error: "invalid_body", required: ["id"] });
  const replied = Boolean(body.replied);
  const replyChannel = body.replyChannel || null;
  if (replied && !REPLY_CHANNEL_KEYS.includes(replyChannel)) {
    return json(res, 400, { error: "reply_channel_required", hint: "どこから返信があったかを選んでください" });
  }
  if (!replied && replyChannel) return json(res, 400, { error: "bad_body", hint: "返信元は「先方から返信」のときだけ選べます" });
  const contactChannel = body.contactChannel || null;
  if (contactChannel && !CONTACT_CHANNEL_KEYS.includes(contactChannel)) {
    return json(res, 400, { error: "bad_contact_channel", allowed: CONTACT_CHANNEL_KEYS });
  }
  const contacts = normalizeContacts(body.contacts);
  if (contacts.error) return json(res, 400, contacts);
  const note = body.note ? String(body.note).trim().slice(0, 2000) || null : null;

  const { company: c, error: e0 } = await loadCompany(sb, ctx, body.id);
  if (e0) {
    const hint = dbSetupHint(e0, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: e0.message });
  }
  if (!c) return json(res, 404, { error: "not_found" });

  const switched = Boolean(contactChannel && contactChannel !== c.current_contact_channel);
  if (!replied && !switched && !note && !contacts.value) {
    return json(res, 400, { error: "nothing_to_record", hint: "返信元・連絡手段・メモのどれかを入れてください" });
  }

  let occurredAt = new Date().toISOString();
  if (body.occurredAt) {
    const d = new Date(body.occurredAt);
    if (Number.isNaN(d.getTime())) return json(res, 400, { error: "bad_date" });
    occurredAt = d.toISOString();
  }

  // NEXT：その場で決めたものが優先。決めなければ、返信のときだけ「返信対応（当日）」を自動で入れる
  const nextGiven = (body.nextAction !== undefined && body.nextAction !== null && body.nextAction !== "")
    || (body.nextActionOn !== undefined && body.nextActionOn !== null && body.nextActionOn !== "");
  let nextPatch = {};
  if (nextGiven) {
    const n = normalizeCompany({ nextAction: body.nextAction, nextActionOn: body.nextActionOn }, { partial: true });
    if (n.error) return json(res, 400, n);
    nextPatch = n.value;
  } else if (replied && statusRank(c.status) <= statusRank("replied")) {
    nextPatch = autoNext("reply");
  }

  // 営業履歴。返信と切替は別の行にする（時系列で「どこから返事が来て、どこへ移ったか」を追えるように）
  const replyLabel = REPLY_CHANNELS.find((r) => r.key === replyChannel)?.label;
  const rows = [];
  if (replied) {
    rows.push({ event_key: "reply", label: `先方返信：${replyLabel}`, channel: replyChannel, detail: note });
  }
  if (switched) {
    rows.push({
      event_key: "contact_switch",
      label: c.current_contact_channel ? `連絡手段を${channelLabel(contactChannel)}へ切替` : `連絡手段：${channelLabel(contactChannel)}`,
      channel: contactChannel, detail: replied ? null : note,
    });
  }
  if (!rows.length) {
    const ch = contactChannel || c.current_contact_channel || null;
    rows.push({ event_key: "contact", label: ch ? `やり取り（${channelLabel(ch)}）` : "やり取り", channel: ch, detail: note });
  }
  const { error } = await sb.from("gw_sales_events").insert(rows.map((r) => ({
    ...r, tenant_id: ctx.tenantId, company_id: c.id, occurred_at: occurredAt,
    employee_id: ctx.employee?.id || null, created_by: user.id,
  })));
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
  }

  const now = new Date().toISOString();
  const patch = { ...nextPatch, followed_at: now, updated_at: now };
  if (!c.last_contact_at || occurredAt > c.last_contact_at) patch.last_contact_at = occurredAt;
  if (replied && statusRank("replied") > statusRank(c.status)) patch.status = "replied";
  const merged = contacts.value ? mergeContacts(c.contacts, contacts.value) : (c.contacts || {});
  if (contacts.value) patch.contacts = merged;
  const channelNow = contactChannel || c.current_contact_channel || null;
  if (contactChannel) patch.current_contact_channel = contactChannel;
  // いまの連絡手段の連絡先（メールならメールアドレス、電話なら電話番号）
  if (channelNow) {
    const v = merged[channelNow] || (channelNow === "phone" ? c.phone : null) || null;
    if (v !== (c.current_contact_value || null)) patch.current_contact_value = v;
  }

  const { data, error: e2 } = await sb.from("gw_sales_companies").update(patch)
    .eq("id", c.id).eq("tenant_id", ctx.tenantId).select(COMPANY_FIELDS).single();
  if (e2) return json(res, e2.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: e2.message });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "sales.contact_add",
    target: `sales_company:${c.id}`,
    detail: { replied, replyChannel, contactChannel, switched, contactKeys: Object.keys(contacts.value || {}) },
  });
  return json(res, 200, { company: shapeCompany(data || c) });
}
