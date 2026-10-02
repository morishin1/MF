// PostgREST（Supabase）から、行を「切り捨てずに」読む部品。
//
// ■ なぜ要るのか
//   Supabase は、1回の応答の行数に上限がある（max-rows。既定 1000）。.limit(5000) と書いても、
//   1000 件で黙って切られ、エラーにならない。経営の集計（経費・仕訳・契約・チェックリスト）が
//   1000 件を超えると、「正確」と表示したまま、合計が足りなくなる。
//   もう一つ、.in("id", [数百件]) は条件が URL に入るので、長すぎて断られる。
//
// ■ どう読むか
//   readAll … 範囲（range）を1000件ずつずらして、空のページが返るまで読む（上限がいくつでも切られない）。
//             途中で失敗したら、または多すぎて読み切れなければ null（呼ぶ側は「データ未連携」にする。0や一部を正確と言わない）
//   readIn  … ids を 100 件ずつに分けて、それぞれ readAll。1つでも読めなければ null
//   ページをずらすので、query は並び順（.order("id") など）を持つこと（順番が定まらないと、重複・漏れが起きる）
//
// query は、毎回作り直す関数で渡す（Supabase の query は1回使うと使えない）。

export const PAGE = 1000;
export const IN_CHUNK = 100;

export const chunks = (a, n = IN_CHUNK) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));

/**
 * @param {() => any} make  query を返す関数（.order(...) つき）
 * @returns {Promise<object[]|null>}
 */
export async function readAll(make, { pageSize = PAGE, maxPages = 40 } = {}) {
  const out = [];
  for (let i = 0; i < maxPages; i++) {
    let r;
    try { r = await make().range(i * pageSize, (i + 1) * pageSize - 1); } catch { return null; }
    if (!r || r.error) return null;
    const rows = r.data || [];
    if (!rows.length) return out;
    out.push(...rows);
  }
  return null;   // maxPages × pageSize 件を超えた。切り捨てたまま返さない
}

/**
 * @param {(part: string[]) => any} make  ids の一部を受けて query を返す関数
 * @returns {Promise<object[]|null>}
 */
export async function readIn(make, ids, { size = IN_CHUNK, ...opts } = {}) {
  const out = [];
  for (const part of chunks([...new Set(ids)], size)) {
    const rows = await readAll(() => make(part), opts);
    if (rows === null) return null;
    out.push(...rows);
  }
  return out;
}
