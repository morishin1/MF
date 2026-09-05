// Vercel REST API の呼び出し。
//
// できること・できないことをはっきりさせておく:
//
//   プロジェクト一覧（GET /v9/projects）
//     公開されている正式なAPI。トークンがあれば確実に取れる。
//
//   Web Analytics の数値
//     こちらは事情が違う。Vercel はダッシュボードで PV・訪問者を見せているが、
//     それを取り出す「公開された」REST API は用意されていない（2026年前半時点）。
//     ダッシュボードが内部で叩いている経路を借りることはできるが、
//     いつ形が変わってもおかしくないし、消えても文句は言えない。
//
//     そこで、ここでは
//       ・借りられるなら借りる（fetchAnalytics）
//       ・断られたら理由を残して静かに諦める
//     という形にしている。数字が取れないサイトは画面に「取得できません」と出る。
//
//     確実に数える手段は自前の計測タグ（js/beacon.js → /api/collect）で、
//     そちらが本命。この関数は「入っていれば拾える」程度の位置づけ。
//
// 必要な環境変数:
//   VERCEL_API_TOKEN … Vercel → Account Settings → Tokens で発行
//   （任意）VERCEL_TEAM_ID … チームのプロジェクトを見るとき

const API = "https://api.vercel.com";

export function isConfigured() {
  return Boolean((process.env.VERCEL_API_TOKEN || "").trim());
}

function teamQuery() {
  const t = (process.env.VERCEL_TEAM_ID || "").trim();
  return t ? `teamId=${encodeURIComponent(t)}` : "";
}

async function call(path, { base = API } = {}) {
  const token = (process.env.VERCEL_API_TOKEN || "").trim();
  if (!token) throw new Error("VERCEL_API_TOKEN が未設定です");

  const r = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error?.message || `HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

/**
 * プロジェクト一覧。ページをたどって全部返す。
 * @returns {Promise<{id:string, name:string, domain:string|null}[]>}
 */
export async function listProjects() {
  const out = [];
  let until = null;

  // 100件ずつ。17件でも将来増えても同じ形で動くようにしておく
  for (let page = 0; page < 20; page++) {
    const q = [teamQuery(), "limit=100", until ? `until=${until}` : ""].filter(Boolean).join("&");
    const data = await call(`/v9/projects?${q}`);
    for (const p of data.projects || []) {
      out.push({ id: p.id, name: p.name, domain: primaryDomain(p) });
    }
    until = data.pagination?.next;
    if (!until) break;
  }
  return out;
}

// 表示に使う代表ドメイン。本番の別名があればそれを優先し、
// 無ければ *.vercel.app を使う
function primaryDomain(p) {
  const alias = (p.targets?.production?.alias || []).find((a) => !a.endsWith(".vercel.app"));
  if (alias) return alias;
  return (p.targets?.production?.alias || [])[0] || (p.alias || [])[0]?.domain || null;
}

/**
 * Web Analytics の日別の数値。
 * 取れなければ例外を投げず、理由を添えて null を返す。
 * 呼び出し側はこれを「未設定・取得不可」として扱う。
 *
 * @returns {Promise<{days:object[], referrers:object[], pages:object[]}|{unavailable:string}>}
 */
export async function fetchAnalytics(projectId, { from, to }) {
  if (!isConfigured()) return { unavailable: "no_token" };

  const q = [
    teamQuery(),
    `projectId=${encodeURIComponent(projectId)}`,
    `from=${encodeURIComponent(new Date(from).toISOString())}`,
    `to=${encodeURIComponent(new Date(to).toISOString())}`,
  ].filter(Boolean).join("&");

  try {
    const data = await call(`/v1/web-analytics/timeseries?${q}`);
    return normalize(data);
  } catch (e) {
    // 404/403 は「この経路は使えない」。それ以外は一時的な失敗として理由を残す
    return { unavailable: e.status === 404 || e.status === 403 ? "not_available" : String(e.message || e) };
  }
}

// 返ってくる形が変わっても落ちないよう、拾えた分だけ拾う
function normalize(data) {
  const rows = Array.isArray(data) ? data : (data?.data || data?.timeseries || []);
  const days = [];
  for (const r of rows) {
    const date = String(r.date || r.key || r.t || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    days.push({
      date,
      pageviews: Number(r.total ?? r.pageviews ?? r.views ?? 0) || 0,
      visitors: Number(r.devices ?? r.visitors ?? r.uniques ?? 0) || 0,
    });
  }
  return { days, referrers: [], pages: [] };
}
