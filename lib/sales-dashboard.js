// Sales ダッシュボード（/sales/）の「今日やること」4段。
//
// ■ なぜサーバで組み立てるのか（表示速度）
//   これまでは画面が企業の全件（最大5,000社・アタック最大20,000件を集計したもの）を受け取り、
//   画面の中で4段に振り分けて、各段の上位10〜20社だけを出していた。
//   受け取るのは全件、見せるのは最大70社。1回目の表示は、全件が届くまで何も出なかった。
//   振り分けの決まりはそのままサーバへ移し、件数と上位だけを返す（GET /api/sales/companies?view=dashboard）。
//
// ■ 決まりは変えていない（sales/index.html にあったものと同じ）
//   1社は、上の段に入ったら下の段には出さない（同じ会社を2回見せない）。
//   段の順：リード・未対応 → 返信あり → 今日フォロー → 今日アタック。
//   並び：リードは最終クリックが新しい順（同じならクリック回数が多い順）、ほかは期限超過が先・期限が近い順。

export const DASHBOARD_KEYS = ["click", "replied", "follow", "attack"];
/** 各段で返す（画面に出す）社数。超えたぶんは件数だけ */
export const DASHBOARD_LIMIT = { click: 20, replied: 20, follow: 20, attack: 10 };

const RECENT_MS = 30 * 86400000;
const isOpen = (c) => !c.ngReason && !["won", "lost", "excluded"].includes(c.status);

const DEFAULT_SORT = (x, y) => (y.overdue ? 1 : 0) - (x.overdue ? 1 : 0)
  || String(x.nextDue || "9").localeCompare(String(y.nextDue || "9"));

const RULES = {
  click: {
    pick: (c) => c.unhandledClick,
    sort: (x, y) => String(y.lastClickAt || "").localeCompare(String(x.lastClickAt || "")) || y.clickCount - x.clickCount,
  },
  replied: { pick: (c) => isOpen(c) && c.status === "replied" },
  follow: {
    pick: (c, { today }) => isOpen(c) && !["untouched", "reattack_wait"].includes(c.status) && Boolean(c.nextDue && c.nextDue <= today),
  },
  attack: {
    pick: (c, { today, now }) => isOpen(c) && ["untouched", "reattack_wait"].includes(c.status)
      && !(c.lastSentAt && now - new Date(c.lastSentAt).getTime() < RECENT_MS)
      && (!c.nextDue || c.nextDue <= today),
  },
};

/**
 * 企業の一覧（api/sales/companies の全件の形）を4段に振り分ける。
 * @param {object[]} companies
 * @param {{today:string, now?:number}} at
 * @returns {Record<string, object[]>} 段ごとの全件（並べ済み）
 */
export function dashboardLists(companies, { today, now = Date.now() }) {
  const used = new Set();
  const lists = {};
  for (const key of DASHBOARD_KEYS) {
    const r = RULES[key];
    lists[key] = companies.filter((c) => !used.has(c.id) && r.pick(c, { today, now })).sort(r.sort || DEFAULT_SORT);
    for (const c of lists[key]) used.add(c.id);
  }
  return lists;
}

/** 画面に返す形：段ごとの件数と、上位（DASHBOARD_LIMIT 社）だけ */
export function dashboardSections(companies, at) {
  const lists = dashboardLists(companies, at);
  return Object.fromEntries(DASHBOARD_KEYS.map((k) => [k, {
    total: lists[k].length,
    rows: lists[k].slice(0, DASHBOARD_LIMIT[k]).map(dashboardRow),
  }]));
}

/** 段の1行で画面が使う項目だけ（全件の形から、出さないものを落とす） */
function dashboardRow(c) {
  return {
    id: c.id, name: c.name, status: c.status, statusLabel: c.statusLabel, service: c.service || null,
    lastSentAt: c.lastSentAt || null, lastService: c.lastService || null,
    clickCount: c.clickCount || 0, lastClickAt: c.lastClickAt || null, unhandledClick: Boolean(c.unhandledClick),
    next: c.next, nextDue: c.nextDue || null, overdue: Boolean(c.overdue), ownerName: c.ownerName || null,
  };
}
