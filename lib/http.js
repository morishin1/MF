// 小さな HTTP ヘルパ

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export async function readJson(req) {
  // Vercel Node ランタイムでは req.body が既にパース済みの場合あり
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

export function methodNotAllowed(res, allowed) {
  res.setHeader("Allow", allowed.join(", "));
  json(res, 405, { error: "method_not_allowed" });
}

/**
 * DBのエラーを、読んで直せる文にする。
 *
 * ■ なぜ要るのか
 *   Supabase（PostgREST）は表を知らないとき
 *   「Could not find the table 'public.xxx' in the schema cache」を返す。
 *   これがそのまま画面に出ると、押した人には何のことか分からないし、
 *   管理者にも「SQLを流せば直る」ことが伝わらない。
 *
 *   原因は、たいてい次のどちらか。
 *     ・その表を作る SQL をまだ流していない
 *     ・流したが、APIが持っている表の一覧が古いまま
 *   どちらも、やることは「SQLを流す」で同じ。
 *
 * @param {object} error Supabase から返ったエラー
 * @param {string} sqlFile 流してほしいファイル名（例 "db/048_timecard.sql"）
 * @returns {string|null} 画面に出す一言。当てはまらなければ null
 */
export function dbSetupHint(error, sqlFile) {
  const msg = String(error?.message || "");
  const code = String(error?.code || "");
  // PGRST205 = 表が見つからない / 42P01 = relation does not exist
  const missing = code === "PGRST205" || code === "42P01"
    || /schema cache/i.test(msg) || /does not exist/i.test(msg);
  if (!missing) return null;
  return `この機能に必要なテーブルがまだ作られていません。`
    + `管理者に ${sqlFile} の実行を依頼してください`;
}
