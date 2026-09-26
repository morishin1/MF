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
//   フィンガープリントも使わない。リンクのプレビューを作りにくる機械（Slack・
//   メールのセキュリティ製品など）はクリックとして数えない。

import { admin } from "../../lib/supabase.js";
import { notify } from "../../lib/notify.js";
import { notifySlack } from "../../lib/slack.js";
import { TRACKING_RE, isBot, ipHash, statusRank, safeUrl } from "../../lib/sales.js";

// 同じ人（同じIPハッシュ）の、この秒数以内の連打は1回と数える
const DEDUPE_SECONDS = 30;

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

  // プレビュー・HEAD は数えない。飛ばすだけ
  const ua = String(req.headers?.["user-agent"] || "").slice(0, 500);
  if (req.method === "HEAD" || isBot(ua)) return redirect(res, dest);

  try {
    await record(sb, a, { ua, dest, req });
  } catch (e) {
    console.error("[sales/r] record failed:", e?.message || e);
  }
  return redirect(res, dest);
}

async function record(sb, a, { ua, dest, req }) {
  const ip = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "";
  const hash = ipHash(ip);
  const now = new Date();
  const nowIso = now.toISOString();

  // 連打・二重読み込みを1回にまとめる
  if (hash) {
    const { data: recent } = await sb.from("gw_sales_click_events").select("id")
      .eq("approach_id", a.id).eq("ip_hash", hash)
      .gte("clicked_at", new Date(now.getTime() - DEDUPE_SECONDS * 1000).toISOString()).limit(1);
    if (recent?.length) return;
  }

  const clickNo = (a.click_count || 0) + 1;
  await sb.from("gw_sales_click_events").insert({
    tenant_id: a.tenant_id, approach_id: a.id, company_id: a.company_id,
    clicked_at: nowIso, destination_url: dest, click_no: clickNo,
    user_agent: ua || null,
    referrer: String(req.headers?.referer || req.headers?.referrer || "").slice(0, 500) || null,
    ip_hash: hash,
  });
  await sb.from("gw_sales_approaches").update({
    click_count: clickNo, last_click_at: nowIso, first_click_at: a.first_click_at || nowIso,
  }).eq("id", a.id);

  const { data: c } = await sb.from("gw_sales_companies")
    .select("id, name, status, owner_id").eq("id", a.company_id).maybeSingle();
  if (!c) return;
  if (statusRank("clicked") > statusRank(c.status)) {
    await sb.from("gw_sales_companies").update({ status: "clicked", updated_at: nowIso }).eq("id", c.id);
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
