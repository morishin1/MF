// GET /r/<token>（vercel.json で /api/sales/r?t=<token> へ書き換え）
//
// 営業文に入れた専用URL。クリックされたら
//   1. クリックを記録する（アタックの回数・初回・最終も更新）
//   2. 担当者へGW通知（可能ならSlackにも）
//   3. 本来のページへリダイレクトする
// ログイン不要。書き込みは service_role で行う（RLSの公開ポリシーは作らない）。
//
// ■ 何があっても、本来のページへは飛ばす
//   記録に失敗した・トークンが無い・表がまだ無い、どの場合も相手の画面では
//   普通にページが開くようにする。営業先に「エラー」を見せない。
//
// ■ 過度に追いかけない（要件 §11）
//   IPは持たない（日替わりの塩を混ぜたハッシュだけ）。Cookie も
//   フィンガープリントも使わない。
//
// ■ ログと「有効クリック」を分ける（lib/sales.js classifyClick）
//   アクセスは全部 gw_sales_click_events に残す。回数・通知・ステータス・NEXT に
//   効くのは、人のクリックと判断したもの（is_valid=true）だけ。数えないのは
//     HEAD・先読み（Sec-Purpose: prefetch 等）・UAなし・機械のUA
//     （Slack・Teams・LINE・メールのセキュリティ製品・HTTPライブラリ）・
//     同じアタックへの30秒以内の連続（同じIPハッシュ）

import { admin } from "../../lib/supabase.js";
import { notify } from "../../lib/notify.js";
import { notifySlack } from "../../lib/slack.js";
import {
  TRACKING_RE, classifyClick, ipHash, statusRank, safeUrl, autoNext, DEDUPE_SECONDS, CLOSED_STATUSES,
} from "../../lib/sales.js";

function fallbackUrl() {
  return safeUrl(process.env.SALES_FALLBACK_URL) || "https://8grp.co.jp/";
}

function redirect(res, url) {
  res.statusCode = 302;
  res.setHeader("Location", url);
  // 途中の仕組みに覚えられると、2回目以降のクリックが届かなくなる
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.end();
}

const hhmm = (iso) => new Date(new Date(iso).getTime() + 9 * 3600000).toISOString().slice(11, 16);
const mdhm = (iso) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600000).toISOString();
  return `${d.slice(5, 7)}/${d.slice(8, 10)} ${d.slice(11, 16)}`;
};

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    return res.end();
  }
  const token = String(new URL(req.url, "http://localhost").searchParams.get("t") || "").toUpperCase();
  if (!TRACKING_RE.test(token)) return redirect(res, fallbackUrl());

  let sb;
  let a;
  try {
    sb = admin();
    const r = await sb.from("gw_sales_approaches")
      .select("id, tenant_id, company_id, employee_id, service, destination_url, sent_at, prepared_at, first_click_at, click_count")
      .eq("tracking_token", token).maybeSingle();
    a = r.data;
  } catch (e) {
    console.error("[sales/r] lookup failed:", e?.message || e);
  }
  if (!a) return redirect(res, fallbackUrl());

  const dest = safeUrl(a.destination_url) || fallbackUrl();

  const ua = String(req.headers?.["user-agent"] || "").slice(0, 500);
  try {
    await record(sb, a, { ua, dest, req });
  } catch (e) {
    console.error("[sales/r] record failed:", e?.message || e);
  }
  return redirect(res, dest);
}

async function record(sb, a, { ua, dest, req }) {
  const ip = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
  // IPが取れないときは UA で見分ける（連打の判定にしか使わない）
  const hash = ipHash(ip || (ua ? `ua:${ua}` : ""));
  const now = new Date();
  const nowIso = now.toISOString();

  // 同じアタックへの、同じ人の短時間の連続（有効クリックの直後だけを見る）
  let duplicate = false;
  if (hash) {
    const { data: recent } = await sb.from("gw_sales_click_events").select("id")
      .eq("approach_id", a.id).eq("ip_hash", hash).eq("is_valid", true)
      .gte("clicked_at", new Date(now.getTime() - DEDUPE_SECONDS * 1000).toISOString()).limit(1);
    duplicate = Boolean(recent?.length);
  }
  const { valid, reason } = classifyClick({ method: req.method, ua, headers: req.headers || {}, duplicate });
  // ログは全部残す（数えないものも）
  const { data: ev } = await sb.from("gw_sales_click_events").insert({
    tenant_id: a.tenant_id, approach_id: a.id, company_id: a.company_id,
    clicked_at: nowIso, destination_url: dest, method: String(req.method || "GET").toUpperCase(),
    is_valid: valid, excluded_reason: reason,
    user_agent: ua || null,
    referrer: String(req.headers?.referer || req.headers?.referrer || "").slice(0, 500) || null,
    ip_hash: hash,
  }).select("id").single();
  if (!valid) return;

  // 回数は「読んだ値＋1」にしない。同時に2人が開くと、どちらも1回目になってしまう。
  // 記録したあとに有効クリックを数え直す（同時でも、あとから書いたほうが正しい数になる）
  const { data: all } = await sb.from("gw_sales_click_events").select("id, clicked_at")
    .eq("approach_id", a.id).eq("is_valid", true).limit(10000);
  const clickNo = Math.max((all || []).length, 1);
  const firstAt = (all || []).map((x) => x.clicked_at).sort()[0] || nowIso;
  if (ev?.id) await sb.from("gw_sales_click_events").update({ click_no: clickNo }).eq("id", ev.id);
  await sb.from("gw_sales_approaches").update({
    click_count: clickNo, last_click_at: nowIso, first_click_at: firstAt,
  }).eq("id", a.id);

  const { data: c } = await sb.from("gw_sales_companies")
    .select("id, name, status, owner_id, ng_reason").eq("id", a.company_id).maybeSingle();
  if (!c) return;
  // 営業禁止・失注・対象外の会社は、古いリンクが開かれても営業を再開しない（ログと回数だけ残す）
  if (c.ng_reason || CLOSED_STATUSES.includes(c.status)) return;
  // 返信・商談より前の会社だけ、ステータスと NEXT を「クリックあり・要フォロー」へ。
  // 返信対応・商談準備の最中なら、そちらの NEXT を残す（クリックは未対応クリックとして別に出る）
  if (statusRank(c.status) < statusRank("replied")) {
    await sb.from("gw_sales_companies").update({
      ...(statusRank("clicked") > statusRank(c.status) ? { status: "clicked" } : {}),
      ...autoNext("click", now), updated_at: nowIso,
    }).eq("id", c.id);
  }

  // 通知は、送った人と会社の担当者へ（同じ人なら1通）
  const to = [...new Set([a.employee_id, c.owner_id].filter(Boolean))];
  const sentAt = a.sent_at || a.prepared_at;
  const lines = [
    `会社名：${c.name}`,
    sentAt ? `送信日時：${mdhm(sentAt)}${a.sent_at ? "" : "（送信完了が未記録）"}` : null,
    `クリック日時：${mdhm(nowIso)}`,
    `クリック回数：${clickNo}回`,
    a.service ? `提案サービス：${a.service}` : null,
  ].filter(Boolean);
  const link = `sales/companies.html?id=${c.id}`;

  await Promise.all([
    notify(to.map((employeeId) => ({
      tenantId: a.tenant_id, employeeId, kind: "sales",
      title: `${c.name}が営業リンクをクリックしました`,
      body: lines.join("\n"), link: `/${link}`,
      // 同じ会社のクリックは1件にまとめて、最新の回数で上書きする
      dedupeKey: `sales_click:${c.id}`,
    }))),
    notifySlack({
      text: `🔥 営業反応あり\n\n${c.name}${a.service ? `\n${a.service}提案` : ""}`,
      lines: [
        "",
        sentAt ? `${hhmm(sentAt)} フォーム送信` : null,
        a.first_click_at ? `${hhmm(a.first_click_at)} 初回クリック` : null,
        `${hhmm(nowIso)} ${clickNo === 1 ? "初回クリック" : `${clickNo}回目クリック`}`,
        "",
        "企業詳細を見る：",
      ],
      link,
    }),
  ]);
}
