// POST /api/sales/lp-lead  { sr?, submissionId, company?, name?, email, tel?, size?, services?[], attribution?{} }
//
// MGNDigital の LP（https://8grp.co.jp/lp/）の申込フォームから、送信が成功したあとに呼ぶ。
// 申込そのものは、これまでどおり LP から contact_public_submit（受信箱・Slack）に入っている。
// ここは /sales の会社に「申込があった」ことを結びつけるだけ（失敗しても申込は失われない）。
//
//   sr（営業リンク /r/<token> が LP に付けたトークン）がある
//     → そのアタックの会社を「MGNDigital申込あり」に（返信ありと同じ段階。後ろへは戻さない）
//        営業履歴に lp_apply（希望サービス・連絡先）、NEXT「商談を予定する」（当日）、担当へ通知
//   sr が無い
//     → メールのドメイン（フリーメール以外）に一致する会社がちょうど1社なら、その会社に
//        lp_candidate（既存企業候補・要確認）を残して担当へ通知するだけ。状態は動かさない。
//        0社・2社以上なら何もしない（新しい会社は作らない＝重複を作らない）
//
// ■ だれでも呼べる口なので
//   ・LP のホスト（env SALES_LP_HOSTS。既定 8grp.co.jp）からのブラウザ呼び出しだけ受ける（Origin）
//   ・形が悪いものは捨てる（lib/sales-lp.js normalizeLpLead）
//   ・同じ申込ID は2回記録しない
//   ・短時間の連続送信を止める（lib/sales-lp.js LP_RATE。表は増やさない）
//       同じ送信元 60秒に3回まで（429）／全体 10分に30件まで（429）／同じ会社 10分に3件まで（黙って記録しない）
//   ・返事は会社が見つかったかどうかを言わない（{ ok: true } だけ）
//   ・ログに連絡先を出さない
// 表は増やさない（DB変更なし）。書き込みは service_role。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { notify } from "../../lib/notify.js";
import { notifySlack } from "../../lib/slack.js";
import { gwLog } from "../../lib/gw-audit.js";
import {
  TRACKING_RE, statusRank, todayJst, bizDayOnOrAfter, CLOSED_STATUSES, mergeContacts, ipHash,
} from "../../lib/sales.js";
import {
  LP_EVENT, LP_EVENT_KEYS, LP_LABEL, LP_NEXT, lpHosts, normalizeLpLead, lpEventDetail, parseLpDetail,
  companyDomainOfEmail, LP_RATE, senderAllowed,
} from "../../lib/sales-lp.js";

// 送信元ごとの回数（このインスタンスのメモリ。lib/sales-lp.js senderAllowed）
const senders = new Map();
export const _resetLpRate = () => senders.clear();   // テスト用

const sinceMin = (min) => new Date(Date.now() - min * 60_000).toISOString();

function allowedOrigin(req) {
  const origin = String(req.headers?.origin || "");
  if (!origin) return null;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && u.hostname === "localhost")) return null;
    const h = u.hostname.toLowerCase().replace(/^www\./, "");
    return lpHosts().some((d) => h === d || h.endsWith(`.${d}`)) ? origin : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  const origin = allowedOrigin(req);
  res.setHeader("Vary", "Origin");
  res.setHeader("Cache-Control", "no-store");
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") { res.statusCode = origin ? 204 : 403; return res.end(); }
  if (req.method !== "POST") return methodNotAllowed(res, ["POST", "OPTIONS"]);
  if (!origin) return json(res, 403, { error: "forbidden_origin" });

  const ip = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
  if (!senderAllowed(senders, ipHash(ip))) return json(res, 429, { error: "rate_limited" });

  const body = await readJson(req);
  const lead = normalizeLpLead(body);
  if (lead.error) return json(res, 400, { error: lead.error });

  let sb;
  try {
    sb = admin();
    // 全体の勢い（荒らされたときの歯止め）。数えられなければ止めない（申込を落とさない）
    const { count, error } = await sb.from("gw_sales_events").select("id", { count: "exact", head: true })
      .in("event_key", LP_EVENT_KEYS).gte("occurred_at", sinceMin(LP_RATE.global.windowMin));
    if (!error && (count || 0) >= LP_RATE.global.max) return json(res, 429, { error: "rate_limited" });
  } catch (e) {
    console.error("[sales/lp-lead] rate check failed:", e?.message || e);
  }

  try {
    if (lead.value.token) await byToken(sb, lead.value);
    else await byDomain(sb, lead.value);
  } catch (e) {
    // 申込そのものは受信箱に入っている。ここで失敗しても LP の画面にはエラーを出さない
    console.error("[sales/lp-lead] failed:", e?.message || e);
  }
  return json(res, 200, { ok: true });
}

/**
 * 記録しないでよいか：同じ申込ID がこの会社に記録済み、または同じ会社への申込の記録が多すぎる
 * （10分に3件まで。lib/sales-lp.js LP_RATE.company）
 */
async function alreadyRecorded(sb, companyId, submissionId) {
  const { data } = await sb.from("gw_sales_events").select("id, event_key, detail, occurred_at")
    .eq("company_id", companyId).in("event_key", LP_EVENT_KEYS).limit(500);
  if ((data || []).some((e) => parseLpDetail(e.detail).submissionId === submissionId)) return true;
  const since = sinceMin(LP_RATE.company.windowMin);
  const recent = (data || []).filter((e) => e.event_key !== "lp_reject" && String(e.occurred_at) >= since).length;
  return recent >= LP_RATE.company.max;
}

async function byToken(sb, v) {
  if (!TRACKING_RE.test(v.token)) return;
  const { data: a } = await sb.from("gw_sales_approaches")
    .select("id, tenant_id, company_id, employee_id, service").eq("tracking_token", v.token).maybeSingle();
  if (!a) return byDomain(sb, v);   // トークンが古い・壊れている → ドメインの候補として扱う
  const { data: c } = await sb.from("gw_sales_companies")
    .select("id, tenant_id, name, status, owner_id, ng_reason, phone, contacts, last_contact_at")
    .eq("id", a.company_id).eq("tenant_id", a.tenant_id).maybeSingle();
  if (!c) return;
  if (await alreadyRecorded(sb, c.id, v.submissionId)) return;

  const nowIso = new Date().toISOString();
  await sb.from("gw_sales_events").insert({
    tenant_id: c.tenant_id, company_id: c.id, event_key: LP_EVENT.apply, label: LP_LABEL.lp_apply,
    detail: lpEventDetail(v, { via: "営業リンク" }), occurred_at: nowIso, channel: "form",
    employee_id: null, created_by: null,
  });

  // 営業禁止・失注・対象外の会社は、申込を記録して知らせるだけ（営業は再開しない）
  const closed = Boolean(c.ng_reason) || CLOSED_STATUSES.includes(c.status);
  const patch = { last_contact_at: nowIso, updated_at: nowIso };
  // 連絡先は空いているところだけ埋める（人が入れたものは上書きしない）
  const contacts = c.contacts && typeof c.contacts === "object" ? c.contacts : {};
  const fill = {};
  if (!contacts.email) fill.email = v.email;
  if (v.phone && !contacts.phone) fill.phone = v.phone;
  if (Object.keys(fill).length) patch.contacts = mergeContacts(contacts, fill);
  if (v.phone && !c.phone) patch.phone = v.phone;
  if (!closed) {
    if (statusRank("replied") > statusRank(c.status)) patch.status = "replied";
    // 商談より先に進んでいる会社の NEXT は動かさない
    if (statusRank(c.status) <= statusRank("replied")) {
      patch.next_action = LP_NEXT;
      patch.next_action_on = bizDayOnOrAfter(todayJst());
    }
  }
  await sb.from("gw_sales_companies").update(patch).eq("id", c.id).eq("tenant_id", c.tenant_id);

  await gwLog({
    tenantId: c.tenant_id, actorId: null, action: "sales.lp_apply",
    target: `sales_company:${c.id}`, detail: { via: "token", services: v.services.length, closed },
  });
  const to = [...new Set([a.employee_id, c.owner_id].filter(Boolean))];
  const lines = [
    `会社名：${c.name}`,
    `希望サービス：${v.services.length ? v.services.join("、") : "未選択（相談したい）"}`,
    v.name ? `お名前：${v.name}` : null,
    closed ? "※ 営業禁止・終了済みの会社です。状態は変えていません" : "NEXT：商談を予定する",
  ].filter(Boolean);
  const link = `sales/leads.html?id=${c.id}`;
  await Promise.all([
    notify(to.map((employeeId) => ({
      tenantId: c.tenant_id, employeeId, kind: "sales",
      title: `${c.name}からMGNDigitalの申込がありました`,
      body: lines.join("\n"), link: `/${link}`, dedupeKey: `sales_lp:${c.id}`,
    }))),
    notifySlack({
      text: `✅ MGNDigital申込（/sales 正式リード）\n\n${c.name}`,
      lines: ["", `希望サービス：${v.services.length ? v.services.join("、") : "未選択"}`, "", "企業詳細を見る："],
      link,
    }),
  ]);
}

async function byDomain(sb, v) {
  const domain = companyDomainOfEmail(v.email);
  if (!domain) return;
  let q = sb.from("gw_sales_companies").select("id, tenant_id, name, owner_id").eq("domain", domain);
  const tenant = String(process.env.SALES_LP_TENANT_ID || "").trim();
  if (tenant) q = q.eq("tenant_id", tenant);
  const { data } = await q.limit(3);
  // ちょうど1社のときだけ候補にする（2社以上は、どれか分からないので人に任せない＝受信箱だけ）
  if (!data || data.length !== 1) return;
  const c = data[0];
  if (await alreadyRecorded(sb, c.id, v.submissionId)) return;

  await sb.from("gw_sales_events").insert({
    tenant_id: c.tenant_id, company_id: c.id, event_key: LP_EVENT.candidate, label: LP_LABEL.lp_candidate,
    detail: lpEventDetail(v, { via: `メールのドメイン ${domain}` }), occurred_at: new Date().toISOString(),
    channel: "form", employee_id: null, created_by: null,
  });
  await gwLog({
    tenantId: c.tenant_id, actorId: null, action: "sales.lp_candidate",
    target: `sales_company:${c.id}`, detail: { via: "domain" },
  });
  if (c.owner_id) {
    await notify([{
      tenantId: c.tenant_id, employeeId: c.owner_id, kind: "sales",
      title: `${c.name}の可能性があるMGNDigital申込があります（要確認）`,
      body: `メールのドメインが一致しました（${domain}）。同じ会社なら「申込として確定」を押してください`,
      link: `/sales/leads.html?id=${c.id}`, dedupeKey: `sales_lp:${c.id}`,
    }]);
  }
}
