// MFアダプタ（Phase 3）
// 承認済み仕訳（journals.status='approved'）を マネーフォワード クラウド会計へ送信する。
// 設計は docs/mf-adapter.md を参照。
//
// 重要（現状の制約）:
//   実際の MF Cloud API エンドポイント / OAuth 仕様が未確定のため、実送信 transport は
//   環境変数 MF_API_BASE が設定され、かつ有効な access token が取得できるまで無効。
//   未設定時は maybeSendToMf() が { sent:false, reason:"mf_not_configured" } を返す
//   （例外は投げない）。呼び出し側は仕訳を status='approved' のまま維持する。
//   MF 仕様が確定したら sendViaHttp() を実装し、トークン取得を有効化するだけで一本道が繋がる。

// 税区分の呼称ゆらぎを MF 想定コードへ寄せる（mf-journal-rules/SKILL.md 準拠）。
// マスタ ID への最終マッピングは MF 側マスタ取込後に行う。
const TAX_ALIASES = {
  "課仕10%": "課対仕入10%",
  "課対仕入10%": "課対仕入10%",
  "課仕8%軽": "課対仕入8%軽",
  "課売10%": "課税売上10%",
  "課税売上10%": "課税売上10%",
  "課売8%軽": "課税売上8%軽",
  "対象外": "対象外",
  "非売": "非課税売上",
};

function normalizeTax(tax) {
  if (!tax) return null;
  return TAX_ALIASES[tax] || tax;
}

/**
 * journals 行 → MF 仕訳ペイロードへ変換（純粋関数・テスト可能）。
 * @param {object} journal  journals テーブルの1行
 * @param {object} ctx      { officeUuid }
 * @returns {object} MF 仕訳ペイロード
 */
export function toMfPayload(journal, { officeUuid } = {}) {
  const lines = Array.isArray(journal.lines) ? journal.lines : [];
  const mfLines = lines.map((l) => ({
    side: l.side, // 'debit' | 'credit'
    account: l.account, // マスタ照合前の勘定科目名（MF側で account_id へ）
    sub_account: l.sub_account || null,
    amount: Number(l.amount) || 0,
    tax_category: normalizeTax(l.tax || (l.side === "debit" ? journal.tax_category : null)),
  }));

  return {
    office_uuid: officeUuid || null,
    date: journal.txn_date || null,
    description: journal.description || "",
    partner_name: journal.partner_name || null,
    department_id: null,
    // 冪等キーは memo に埋め込む（タイムアウト時は memo 検索で確定）
    memo: journal.idempotency_key || null,
    lines: mfLines,
  };
}

// 借方合計 = 貸方合計 を検証（MF 側でも必須）
export function isBalanced(payload) {
  let debit = 0;
  let credit = 0;
  for (const l of payload.lines || []) {
    if (l.side === "debit") debit += l.amount;
    else if (l.side === "credit") credit += l.amount;
  }
  return debit === credit && debit > 0;
}

export function isMfConfigured() {
  return Boolean(process.env.MF_API_BASE);
}

/**
 * 承認済み仕訳を MF へ送信する（設定済みのときのみ実送信）。
 * 例外は投げず、常に結果オブジェクトを返す。
 * @returns {Promise<{sent:boolean, reason?:string, external_id?:string, payload?:object}>}
 */
export async function maybeSendToMf(journal, { officeUuid, accessToken } = {}) {
  const payload = toMfPayload(journal, { officeUuid });

  if (!isBalanced(payload)) {
    return { sent: false, reason: "unbalanced", payload };
  }
  // MF 仕様/認証が未整備の間はここで安全に停止（承認までで確定）
  if (!isMfConfigured() || !accessToken) {
    return { sent: false, reason: "mf_not_configured", payload };
  }

  try {
    const external_id = await sendViaHttp(payload, accessToken);
    return { sent: true, external_id, payload };
  } catch (err) {
    return { sent: false, reason: "send_failed", detail: String(err?.message || err), payload };
  }
}

/**
 * 実 HTTP 送信（MF Cloud API 仕様確定後に実装）。
 * 現状は未構成のため呼ばれない（maybeSendToMf が手前で return する）。
 * TODO(Phase3): docs/mf-adapter.md の変換表に従い account_id / excise_id へマスタ照合し、
 *   冪等チェック（list_journals を memo で検索）→ POST → external_id を返す。
 */
async function sendViaHttp(_payload, _accessToken) {
  throw new Error("MF送信 transport は未実装です（MF Cloud API 仕様の確定待ち）");
}
