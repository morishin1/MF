// 偽の Supabase 用：date 列に渡した日付が、暦に実在するかを見る。
//
// ■ なぜ要るか
//
//   実DB（Postgres）は「2026-09-31」のような実在しない日付を
//   `22008 date/time field value out of range` で拒否する。
//   ところが偽DBは文字列どうしの比較で済ませていたため、
//   `.lte("period_from", `${month}-31`)` のような書き方が通ってしまい、
//   30日までの月・2月で本番だけ落ちるバグをテストで見つけられなかった。
//   偽DBの gt/gte/lt/lte から、これを通して実DBと同じ落ち方をさせる。

/** YYYY-MM-DD の形で、かつ暦に実在するか。日付の形でなければ検査しない（true） */
export const isRealDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return true;
  const [y, mo, d] = m.slice(1).map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
};

/**
 * 偽DBの絞り込み [[op, key, value], …] に、実在しない日付の比較があれば
 * PostgREST が返すのと同じ形のエラーを返す。無ければ null
 */
export const pgDateError = (filters) => {
  const bad = filters.find(([op, , v]) => ["gt", "gte", "lt", "lte"].includes(op) && !isRealDate(v));
  return bad ? { code: "22008", message: `date/time field value out of range: "${bad[2]}"` } : null;
};
