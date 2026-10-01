// 社内AIチャットが参照するナレッジの検索。
//
// この環境には pgvector も日本語の形態素解析辞書も無い（package.json・DB拡張とも
// 未導入）ので、埋め込み検索はやらない。文字2-gram（「有給休暇」→ "有休"
// "休休"... ではなく "有休""休休""休暇" のような2文字の並び）で質問文とナレッジの
// 重なりを数えるだけの、シンプルな方式にする。
//
// 日本語は単語の間にスペースが無いので、英語のような単語単位の一致では拾えない。
// 2-gramなら辞書なしでも「有給休暇」と「休暇の申請」のような表記ゆれにある程度強い。
//
// 件数の多いテナントを想定していない（自社の社内ナレッジなので、せいぜい数百件）。
// 一度に全部読んで点数を付ける素朴な実装でよい。

export const CATEGORIES = [
  { code: "general_affairs", label: "総務" },
  { code: "hr", label: "人事・労務" },
  { code: "accounting", label: "経理" },
  { code: "it", label: "IT" },
  { code: "sales", label: "営業" },
  { code: "rules", label: "社内ルール" },
  { code: "other", label: "その他" },
];
export const CATEGORY_CODES = CATEGORIES.map((c) => c.code);
export const categoryLabel = (code) => CATEGORIES.find((c) => c.code === code)?.label || "その他";

/**
 * ctx（lib/gw.js の gwContext が返す形）から、見てよい access_scope の一覧を返す。
 * db/113 の RLS（gw_ai_knowledge_select）と1対1で対応させてある。
 *
 *   all     … いつも見える
 *   hr      … canManageHr（人事・経営者・会計側管理者）
 *   finance … canAccessOffice（経営者・責任者・経理）
 *   admin   … 経営者・会計側管理者だけ
 *
 * 以前は canManageHr（= gw_is_hr）が true なら finance・admin も含めて
 * 全scopeを素通りさせていたが、それだと「人事」が経理限定・管理者限定の
 * ナレッジまで読めてしまっていた（要件の修正指示）。scopeごとに独立して判定する
 */
export function allowedKnowledgeScopes(ctx, canManageHr, canAccessOffice) {
  const scopes = ["all"];
  if (canManageHr(ctx)) scopes.push("hr");
  if (canAccessOffice(ctx)) scopes.push("finance");
  if (ctx.isAdmin || (ctx.roles || []).includes("owner")) scopes.push("admin");
  return scopes;
}

function bigrams(text) {
  const t = String(text || "").replace(/\s+/g, "");
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

/** 質問文とナレッジ本文の重なり具合。0〜1（質問側のn-gramがどれだけ本文に出てくるか） */
function overlapScore(query, text) {
  const q = bigrams(query);
  if (!q.size) return 0;
  const d = bigrams(text);
  if (!d.size) return 0;
  let hit = 0;
  for (const g of q) if (d.has(g)) hit++;
  return hit / q.size;
}

const SEARCH_LIMIT_ROWS = 300; // テナント内の有効ナレッジを一度に読む上限（素朴な実装の安全弁）

/**
 * @param {object} sb Supabase クライアント（admin()）
 * @param {{tenantId:string, scopes:string[], query:string, category?:string, limit?:number}} opts
 * @returns {Promise<Array<object & {score:number}>>} 関連度の高い順。score>0 のものだけ
 */
export async function searchKnowledge(sb, { tenantId, scopes, query, category, limit = 5 }) {
  let q = sb.from("gw_ai_knowledge")
    .select("id, title, category, content, access_scope, link_url, link_label, updated_at")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .in("access_scope", scopes)
    .limit(SEARCH_LIMIT_ROWS);
  if (category) q = q.eq("category", category);

  const { data, error } = await q;
  if (error) throw error;

  return (data || [])
    .map((row) => ({ ...row, score: overlapScore(query, `${row.title} ${row.title} ${row.content}`) }))
    .filter((row) => row.score > 0.02)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
