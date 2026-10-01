// 応募者・合格通知の給与を、専用の表（gw_hr_pay）で読み書きする。
//
// ■ 何のためか
//   給与が gw_hr_applicants / gw_hr_offers の列に入っていると、採用HRを使える人
//   （採用担当・責任者）が、ブラウザから直接 DB を叩いて読めてしまう（RLS は列を隠せない）。
//   給与を別の表（gw_hr_pay。給与を見られる人だけの RLS）に置く（db/100_hr_pay.sql）。
//
// ■ 切り替え（環境変数 HR_PAY_SPLIT）
//   未設定（既定）… これまでどおり、元の列に読み書きする。この部品は何もしない
//   HR_PAY_SPLIT=1 … 給与を gw_hr_pay から読み、gw_hr_pay へ書く。元の列は読まない・書かない
//   db/100 を流し、突き合わせが一致してから 1 にする（手順は db/100 の先頭）。
//   1 にしたのに gw_hr_pay が無いときは、黙って空にせず、はっきり失敗させる
//   （給与が「無い」ように見えて、上書きしてしまう事故を防ぐ）。
//
// ■ 呼び出し側の約束
//   ・給与を返すのは、見られる人（lib/gw.js canSeeSalary）にだけ。呼ぶ前に確かめる
//   ・書き込みは、サーバ（service_role）だけが行う。RLS に書き込みのポリシーは無い
//   ・合格通知の作成のように、見えない人の操作でも「サーバの中で」給与を引き継ぐのは構わない
//     （応答には載せない。lib/salary.js が出口で外す）

import { admin } from "./supabase.js";
import { json, dbSetupHint } from "./http.js";
import { WAGE_COLUMNS } from "./salary.js";

const PAY = "gw_hr_pay";
// 給与の列の一覧は lib/salary.js に1つだけ（出口の伏せと、ここの分離が食い違うと、給与が漏れる／消える）
export { WAGE_COLUMNS };

/** PostgREST は、条件（in）を URL に入れる。数百件を1本にすると URL が長すぎて断られる */
const CHUNK = 100;
const chunks = (a, n = CHUNK) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));

/** 給与を、専用の表で扱う設定か */
export const paySplit = () => process.env.HR_PAY_SPLIT === "1";

/**
 * gw_hr_pay の読み書きの失敗。
 * 表が無い（db/100 未適用）ときだけ「db/100 を流してください」と言う。
 * 一意制約・桁あふれ・一時的な失敗まで「db/100 を流せ」と言うと、直すべき場所を取り違える。
 */
export class PayError extends Error {
  constructor(error) {
    const detail = error?.message || error?.code || "不明";
    const notReady = Boolean(dbSetupHint(error, "db/100_hr_pay.sql"));
    super(notReady
      ? `gw_hr_pay が使えません（${detail}）。HR_PAY_SPLIT=1 にする前に db/100_hr_pay.sql を流してください`
      : `給与の読み書きに失敗しました（${detail}）`);
    this.code = notReady ? "hr_pay_not_ready" : "hr_pay_failed";
    this.detail = detail;
  }
}
const check = (error) => { if (error) throw new PayError(error); };

/**
 * 給与の書き込みに失敗したときの応答。
 * rollback を渡すと、直前に作った行を消してから返す（給与だけが無い応募者・合格通知を残さない。
 * 残すと、やり直しで二重にできる）。渡さない更新では「給与以外は保存済み」と伝える。
 */
export async function payFailed(res, e, rollback = null) {
  if (!(e instanceof PayError)) throw e;
  let rolledBack = false;
  if (rollback) { try { await rollback(); rolledBack = true; } catch { /* 消せなくても、失敗は伝える */ } }
  return json(res, e.code === "hr_pay_not_ready" ? 503 : 500, {
    error: e.code, detail: e.detail,
    hint: e.code === "hr_pay_not_ready" ? e.message
      : rolledBack ? "給与を保存できなかったため、登録を取り消しました。もう一度お試しください"
        : rollback ? "給与を保存できませんでした。登録済みの内容を確認してください"
          : "給与以外の項目は保存されました。給与だけ保存できませんでした。もう一度保存してください",
  });
}

/**
 * 書き込む値を、元の表の行と給与に分ける。
 * 分けない設定のときは、給与も元の行に残す（これまでどおり）。
 * @returns {{ base: object, wage: object|null }}
 */
export function splitWage(value) {
  if (!paySplit()) return { base: value, wage: null };
  const base = {};
  const wage = {};
  for (const [k, v] of Object.entries(value || {})) (WAGE_COLUMNS.includes(k) ? wage : base)[k] = v;
  return { base, wage: Object.keys(wage).length ? wage : null };
}

/**
 * 応募者（kind="applicant"）または合格通知（kind="offer"）の行に、給与（wage_type・wage_amount）を足す。
 * 分けない設定のときは何もしない（行の元の列が、そのまま使われる）。
 * 分ける設定で、給与の行が無いものは、給与なし（null）になる。
 * @returns 渡した rows（同じ参照）
 */
export async function attachPay(tenantId, rows, kind) {
  if (!paySplit()) return rows;
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  if (!list.length) return rows;

  const ids = list.map((r) => r.id);
  const key = kind === "offer" ? "offer_id" : "applicant_id";
  const byId = new Map();
  // 100 件ずつ（URL が長すぎて断られないように）。1人につき給与の行は高々1つなので、1回で足りる
  for (const part of chunks(ids)) {
    let q = admin().from(PAY).select("applicant_id, offer_id, wage_type, wage_amount").eq("tenant_id", tenantId);
    q = kind === "offer" ? q.in("offer_id", part) : q.in("applicant_id", part).is("offer_id", null);
    const { data, error } = await q.limit(CHUNK * 2);
    check(error);
    for (const p of data || []) byId.set(p[key], p);
  }
  for (const r of list) {
    const p = byId.get(r.id);
    r.wage_type = p?.wage_type ?? null;
    r.wage_amount = p?.wage_amount ?? null;
  }
  return rows;
}

/**
 * 給与を書く（あれば更新、なければ作る）。wage には、変えたい項目だけを入れる。
 * offerId が無ければ「応募者の現在の条件」、あれば「その版の合格通知の条件」。
 */
export async function savePay(tenantId, { applicantId, offerId = null, wage }, _retried = false) {
  if (!wage || !Object.keys(wage).length) return;
  const sb = admin();
  let q = sb.from(PAY).select("id").eq("tenant_id", tenantId).eq("applicant_id", applicantId);
  q = offerId ? q.eq("offer_id", offerId) : q.is("offer_id", null);
  const { data: existing, error } = await q.maybeSingle();
  check(error);

  const now = new Date().toISOString();
  if (existing) {
    const { error: ue } = await sb.from(PAY).update({ ...wage, updated_at: now }).eq("id", existing.id);
    check(ue);
  } else {
    const { error: ie } = await sb.from(PAY).insert({
      tenant_id: tenantId, applicant_id: applicantId, offer_id: offerId, ...wage,
    });
    // 同時にもう1人が保存して、一意制約に当たった。1回だけ、更新としてやり直す
    if (ie && ie.code === "23505" && !_retried) return savePay(tenantId, { applicantId, offerId, wage }, true);
    check(ie);
  }
}

/**
 * 合格通知の給与を、別の版へ引き継ぐ（再発行で新しい版を足すとき）。
 * fromOfferId を省くと、応募者の現在の条件から引き継ぐ。
 * 引き継ぐ給与が無ければ、何もしない。
 */
export async function copyPayToOffer(tenantId, { applicantId, fromOfferId = null, toOfferId }) {
  if (!paySplit()) return;
  const sb = admin();
  let q = sb.from(PAY).select("wage_type, wage_amount").eq("tenant_id", tenantId).eq("applicant_id", applicantId);
  q = fromOfferId ? q.eq("offer_id", fromOfferId) : q.is("offer_id", null);
  const { data, error } = await q.maybeSingle();
  check(error);
  if (!data) return;
  await savePay(tenantId, {
    applicantId, offerId: toOfferId, wage: { wage_type: data.wage_type, wage_amount: data.wage_amount },
  });
}
