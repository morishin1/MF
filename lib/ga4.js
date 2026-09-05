// Google アナリティクス（GA4）Data API。
//
// Vercel の Web Analytics と違い、こちらは公式に公開されていて仕様も安定している。
// 数字の根拠をここに置ける。
//
// 認証は Drive・カレンダーと同じサービスアカウント。鍵を増やさずに済む。
// 必要なのは、その サービスアカウントのメールアドレスを
// 各 GA4 プロパティの「閲覧者」に追加しておくことだけ。
//
// 事前の準備（これをしないと 403 になる）:
//   1. Google Cloud で「Google Analytics Data API」を有効にする
//   2. GA4 → 管理 → プロパティのアクセス管理 → サービスアカウントを「閲覧者」で追加
//   3. 管理画面でプロパティID（数字の羅列）を登録する
//
// プロパティID と 測定ID（G-XXXXXXX）は別物。
//   プロパティID … ここで数字を引くときの宛先
//   測定ID       … サイトに貼るタグに書く方

import { getAccessToken, hasCredentials } from "./gdrive.js";

const API = "https://analyticsdata.googleapis.com/v1beta";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

export function isConfigured() {
  return hasCredentials();
}

async function runReport(propertyId, body) {
  const token = await getAccessToken(SCOPE);
  const r = await fetch(`${API}/properties/${encodeURIComponent(propertyId)}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = data.error?.message || `HTTP ${r.status}`;
    const err = new Error(detail);
    err.status = r.status;
    throw err;
  }
  return data;
}

const rows = (data) => data.rows || [];
const dim = (row, i) => row.dimensionValues?.[i]?.value ?? "";
const met = (row, i) => Number(row.metricValues?.[i]?.value ?? 0) || 0;

/**
 * 日別・人気ページ・流入元をまとめて取る。
 * 取れなければ例外を投げず、理由を添えて返す（画面は出したいので）。
 *
 * @returns {Promise<{days:object[], pages:object[], referrers:object[]}|{unavailable:string}>}
 */
export async function fetchAll(propertyId, { from, to }) {
  if (!isConfigured()) return { unavailable: "no_service_account" };

  const range = [{ startDate: from, endDate: to }];
  try {
    // 3本まとめて投げる。1本でも通れば残りも通るので、失敗はまとめて扱ってよい
    const [daily, pages, refs] = await Promise.all([
      runReport(propertyId, {
        dateRanges: range,
        dimensions: [{ name: "date" }],
        metrics: [{ name: "screenPageViews" }, { name: "totalUsers" }],
        limit: 400,
      }),
      runReport(propertyId, {
        dateRanges: range,
        dimensions: [{ name: "pagePath" }],
        metrics: [{ name: "screenPageViews" }],
        orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
        limit: 25,
      }),
      runReport(propertyId, {
        dateRanges: range,
        // sessionSource は "google" "(direct)" "t.co" のように入る。
        // 参照元URLそのものより、こちらのほうが集計に使いやすい
        dimensions: [{ name: "sessionSource" }],
        metrics: [{ name: "screenPageViews" }],
        orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
        limit: 25,
      }),
    ]);

    return {
      days: rows(daily).map((r) => ({
        // GA4 は "20260905" の形で返す
        date: toIsoDate(dim(r, 0)),
        pageviews: met(r, 0),
        visitors: met(r, 1),
      })).filter((d) => d.date),

      pages: rows(pages).map((r) => ({ path: dim(r, 0) || "/", pageviews: met(r, 0) })),

      referrers: rows(refs).map((r) => ({
        referrer: normalizeSource(dim(r, 0)),
        pageviews: met(r, 0),
      })),
    };
  } catch (e) {
    // 403 は「このプロパティを見る権限が無い」。いちばん多い間違いなので、
    // そのまま出しても分かるように理由を残す
    if (e.status === 403) {
      return { unavailable: "サービスアカウントがGA4プロパティの閲覧者に追加されていません" };
    }
    if (e.status === 404) return { unavailable: "プロパティIDが見つかりません" };
    return { unavailable: String(e.message || e) };
  }
}

function toIsoDate(v) {
  const s = String(v || "");
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

// 計測タグ側（api/collect.js）と同じ見え方に寄せる。
// 2つの出どころで「google」と「google.com」が並ぶと比べにくいため
function normalizeSource(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s || s === "(direct)" || s === "(none)") return "direct";
  if (s.startsWith("google")) return "google";
  if (s.startsWith("yahoo")) return "yahoo";
  if (s.startsWith("bing")) return "bing";
  if (s === "t.co" || s === "x.com" || s === "twitter" || s === "twitter.com") return "x";
  return s.replace(/^www\./, "").slice(0, 200);
}
