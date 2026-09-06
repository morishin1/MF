// Claude の呼び出し設定。7か所に同じ定数を書いていたのをここへ集めた。
//
// ■ なぜ max_tokens を大きくしたか（ここが一番大事）
//   いまの Claude は既定で「考えてから答える」。
//   その考えるぶんのトークンも max_tokens に含まれる。
//
//   以前の 1400〜4000 のままだと、考えるところで枠を使い切って、
//   肝心の答え（tool_use ブロック）が出る前に切れることがある。
//   そうなると「AIがツールを呼びませんでした」で失敗する。
//   日報の評価が理由もなく失敗する、という形で出る。
//
//   max_tokens は上限であって、使い切る前提の数字ではない。
//   実際に課金されるのは出した ぶんだけなので、余裕を持たせて損はない。
//
// ■ モデル
//   ANTHROPIC_MODEL を Vercel に置けば差し替えられる。
//   置かなければ claude-opus-5 を使う。
//
// ■ OpenAI が無いときはここに落ちてくる
//   日報の評価・週次・月次・3か月計画は、OPENAI_API_KEY があれば
//   そちらを使い、無ければ Claude に切り替わる。
//   いまは ANTHROPIC_API_KEY だけなので、全部この設定で動く。

export const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";

/**
 * 用途ごとの上限。考えるぶんの余裕を含む。
 *
 * short  … 短い文章を1つ返すだけのもの
 * normal … 決まった形（JSON）で中くらいの量を返すもの
 * long   … 3か月ぶんの計画のように、まとまった量を返すもの
 */
export const MAX_TOKENS = {
  short: 8000,
  normal: 16000,
  long: 24000,
};

/** 呼び出しの共通部分。model と max_tokens を毎回書かなくて済むように */
export const withDefaults = (opts = {}, size = "normal") => ({
  model: MODEL,
  max_tokens: MAX_TOKENS[size] ?? MAX_TOKENS.normal,
  ...opts,
});
