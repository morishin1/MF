// 日報（tc_nippo）まわりの共通処理。
//
// なぜ既存のテーブルをそのまま使うのか
//   日報は 8grp.co.jp/8/dr/ で1年以上動いていて、過去ぶんが tc_nippo に溜まっている。
//   グループウェアへ移すにあたって表を作り直すと、その過去ぶんが読めなくなるか、
//   移すあいだ「どちらが本物か」が分からない期間ができる。
//   Supabase は同じプロジェクトなので、表はそのまま使い、入口だけを移した。
//
//   さらに好都合なことに tc_profiles.id は auth.users(id) を指している。
//   つまり tc_nippo.user_id は、このグループウェアでログインしている
//   auth ユーザーの id とそのまま同じ。突き合わせ表は要らない。
//
// 書き込みの入口をここ（サーバ側）に絞っている理由
//   tc_* の RLS は anon にも開いている（タイムカードが簡易ログインで動いているため）。
//   その設定はタイムカード側が壊れるので変えられない。
//   代わりに、グループウェアからの書き込みは必ず API を通し、
//   「自分の日報しか書けない」をここで担保する。

const JST = 9 * 3600000;

/** 日本時間での YYYY-MM-DD。サーバは UTC で動くので9時間足してから切る */
export function jstDate(offsetDays = 0) {
  return new Date(Date.now() + JST + offsetDays * 86400000).toISOString().slice(0, 10);
}

/** その日を含む週の月曜日（YYYY-MM-DD） */
export function weekStart(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = d.getUTCDay();               // 0=日
  const back = dow === 0 ? 6 : dow - 1;    // 月曜まで何日戻るか
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

export const MOODS = ["順調", "普通", "苦戦"];
export const PURPOSE_AREAS = ["企業", "人材", "案件", "提案", "参画"];

// 毎日必ず書く4つ。日報の画面はこれだけが最初から見えている状態にする。
//
// 10項目を全部並べていたときは、埋めるのに時間がかかって
// 「今日は書かなくていいか」になりやすかった。毎日出るほうが大事なので、
// 残りは「くわしく書く」の中に入れ、書きたい日だけ開く形にした。
// 列は減らしていないので、過去の日報も、詳しく書いた日もそのまま残る。
export const CORE = ["mood", "today_work", "struggle", "tomorrow_plan"];

const text = (v, max = 4000) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

const num = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 配列項目は「中身が空の行」を落とす。空行がそのまま残ると、あとで数えたときに嘘になる */
function rows(v, pick, required) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const r of v.slice(0, 30)) {
    if (!r || typeof r !== "object") continue;
    const o = {};
    for (const k of pick) o[k] = text(r[k], 500) ?? "";
    if (required.some((k) => !o[k])) continue;
    out.push(o);
  }
  return out.length ? out : null;
}

/**
 * 画面から来た日報を、tc_nippo に入れられる形にする。
 * ここを通っていない値は保存しない（列名を直接指定させない）。
 */
export function normalizeNippo(body) {
  const mood = MOODS.includes(body?.mood) ? body.mood : "順調";
  const area = PURPOSE_AREAS.includes(body?.purpose_area) ? body.purpose_area : null;

  return {
    mood,
    purpose_area: area,
    purpose: text(body?.purpose),
    kgi_week: text(body?.kgi_week),
    progress_done: num(body?.progress_done),
    progress_total: num(body?.progress_total),
    team_kgi: rows(body?.team_kgi, ["name", "goal", "actual"], ["name"]),
    kpis: rows(body?.kpis, ["name", "goal", "actual"], ["name"]),
    today_work: text(body?.today_work),
    // 困っていること。毎日の4項目の1つ。
    // 列は既にある（旧「課題」）ので、意味の同じものを使い回している
    struggle: text(body?.struggle),
    funnel: text(body?.funnel),
    handoff: rows(body?.handoff, ["to_name", "what", "state"], ["to_name", "what"]),
    stuck: rows(body?.stuck, ["item", "pos", "reason", "ball", "next"], ["item"]),
    miss_reason: text(body?.miss_reason),
    challenge: text(body?.challenge),
    small_win: text(body?.small_win),
    contribution: text(body?.contribution),
    tomorrow_plan: text(body?.tomorrow_plan),
  };
}

/** ⑧の感謝。宛先が名簿にいる人かどうかは呼び出し側で確かめる */
export function normalizeThanks(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const t of v.slice(0, 20)) {
    const toUserId = String(t?.toUserId || "").trim();
    const body = text(t?.body, 1000);
    if (!toUserId || !body) continue;
    out.push({ toUserId, body });
  }
  return out;
}

/** 出したかどうかの最低ライン。全部空の日報を「提出済み」にしない */
export function hasContent(n) {
  return Boolean(
    n.today_work || n.tomorrow_plan || n.struggle || n.purpose ||
    n.challenge || n.small_win || n.contribution || n.kpis || n.handoff
  );
}

/**
 * AI自動返信を頼む。
 * 本文は送らない（Edge Function が DB から読む）。保存された日報と
 * AIが読んだ内容が食い違わないようにするため。
 * AI が落ちていても日報の保存はもう終わっているので、ここは例外を外に出さない。
 */
export async function requestAiReply(nippoId) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, reason: "not_configured" };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch(`${url}/functions/v1/nippo-ai-reply`, {
      method: "POST",
      signal: ac.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, apikey: key },
      body: JSON.stringify({ mode: "auto", nippo_id: nippoId }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data) return { ok: false, reason: `http_${r.status}` };
    if (data.error) return { ok: false, reason: String(data.error) };
    if (data.status === "disabled") return { ok: false, reason: "disabled" };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.name === "AbortError" ? "timeout" : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}
