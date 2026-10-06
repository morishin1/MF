// 入社手続きの「いまどこか」。5つの段階と、次に誰が何をするか。
//
// ■ なぜ段階を1つに決めるのか
//
//   これまで入社手続きは、作成依頼（gw_doc_orders）・署名（gw_sign_requests）・
//   届出（gw_onboard_profiles）・同意（gw_onboard_consents）・
//   チェックリスト（gw_procedure_items）と、5つの表に散らばっていた。
//   どれも正しく動いていたが、「山田さんはいまどこで止まっているか」を
//   答えるには、担当者が5つを頭の中で合成するしかなかった。
//   合成を人がやると、必ず誰かの記憶に頼ることになる。
//
//   段階は5つに固定する（相談して決めた形）。
//
//     ① conditions      労働条件の指定・作成依頼      … 管理者
//     ② advisor_review  労働条件の確認・承認          … 社労士
//     ③ signing         労働条件・誓約書の締結        … 入社予定者
//     ④ intake          入社情報の入力・書類の提出    … 入社予定者（並行して社内準備）
//     ⑤ complete        入社手続き完了
//
// ■ 段階は「計算する」。書いておくのは、変わったことに気づくため
//
//   5つの表の事実から、純粋な関数で段階を出す（computeStage）。
//   表にも stage を書くが、それは前回と比べて「進んだ」を検知し、
//   次の担当者へ知らせるためだけ。正はあくまで事実のほう。
//   段階だけ手で書き換えられる作りにすると、事実と段階が必ずずれる。
//
// ■ 判定はここ1か所
//
//   一覧・ダッシュボード・通知の3か所で別々に書くと、3つの答えが出る。

/** 5つの段階。順番どおり */
export const STAGES = [
  { key: "conditions",     n: 1, label: "作成依頼",     actor: "admin",    actorLabel: "管理者",
    todo: "労働条件を入力して、社労士へ作成を依頼する" },
  { key: "advisor_review", n: 2, label: "社労士確認",   actor: "advisor",  actorLabel: "社労士",
    todo: "労働条件を確認して、承認・発行する" },
  { key: "signing",        n: 3, label: "締結",         actor: "employee", actorLabel: "本人",
    todo: "労働条件通知書と誓約書を確認して、締結する" },
  { key: "intake",         n: 4, label: "情報入力・提出", actor: "employee", actorLabel: "本人",
    todo: "入社情報を入力して、必要書類を提出する" },
  { key: "complete",       n: 5, label: "完了",         actor: null,       actorLabel: "—",
    todo: "" },
];
export const STAGE_KEYS = STAGES.map((s) => s.key);
export const stageOf = (key) => STAGES.find((s) => s.key === key) || STAGES[0];

/**
 * 段階の判定に使う「事実の読み取り」。
 *
 * 段階（computeStage）と、それを別の並びで見せる画面（入社準備の6ステップ
 * lib/onboard-six.js）が、同じ読み取りを使うために切り出した。
 * ここで「依頼済みか」「締結済みか」「本人の残り」を決め、呼ぶ側は並べ替えるだけにする
 * （判定を2か所に書くと、画面ごとに違う答えが出る）。
 *
 * @param {object} f  computeStage と同じ
 */
export function stageFlags(f) {
  const proc = f.procedure || {};
  const order = f.order && f.order.status !== "cancelled" ? f.order : null;
  const sign = f.sign && f.sign.status !== "cancelled" ? f.sign : null;
  const items = f.items || [];

  // 本人が出すもの（必須だけ）と、社内で用意するもの
  const isDone = (i) => i.status === "done" || i.status === "na";
  const isIn = (i) => isDone(i) || i.status === "submitted";
  // マイナンバー確認書類は、この仕組みでは受け取らない（社労士側で収集）。
  // 出したかどうかで段階を止めない。進み具合は mynumber_status で別に見る
  const employeeOpen = items.filter((i) => i.owner === "employee" && i.required !== false
    && i.item_key !== "doc_mynumber" && !isIn(i));
  const internalOpen = items.filter((i) => i.owner !== "employee" && !isDone(i));

  // 労働条件通知書の「閲覧・確認」（db/110）。電子署名とは別の事実。
  // 有効な電子署名依頼（sign）がある人は、電子署名のほうを優先する。通知書の確認では、締結にしない
  const notice = f.notice && !sign ? f.notice : null;
  const noticePublished = Boolean(notice?.published);
  const noticeConfirmed = Boolean(noticePublished && notice?.confirmed);

  const signed = sign?.status === "signed" || order?.status === "signed" || noticeConfirmed;
  const sent = sign?.status === "sent" || order?.status === "sent" || noticePublished;
  return {
    noticePath: noticePublished,                    // 通知書の確認で進む人（電子署名の依頼が無い）
    noticeConfirmed,
    cancelled: proc.status === "cancelled",
    closed: proc.status === "done",                 // 管理者が完了にした
    order, sign,
    // 契約書の準備に入った：作成を頼んだ・通知書を公開した・雛形や作成済みPDFで署名依頼を出した
    // （雛形で直接送った人が、作成依頼が無いために①で止まり続けないように）
    ordered: Boolean(order) || noticePublished || Boolean(sign),
    orderUploaded: order?.status === "uploaded",    // 書面は届いたが、発行前
    issued: Boolean(signed || sent),                // 発行した（本人へ届いた）
    signed: Boolean(signed),
    consentsOk: Boolean(f.consentsOk),
    profileSubmitted: f.profile?.status === "submitted",
    employeeOpen: employeeOpen.length,
    internalOpen: internalOpen.length,
    // 事実が渡されなかった（表が無い・読めない）ときは false にならない
    orientationOk: f.orientationOk !== false,
  };
}

/**
 * 事実から段階を出す。
 *
 * @param {object} f
 *   procedure   { status }                        手続き本体
 *   order       { status } | null                 作成依頼（gw_doc_orders、labor conditions）
 *   sign        { status } | null                 署名依頼（gw_sign_requests、employment）
 *   notice      { published, confirmed } | null   労働条件通知書の閲覧・確認（db/110）。電子署名の依頼があれば使わない
 *   consentsOk  boolean                           誓約書等の同意がそろったか
 *   profile     { status } | null                 入社情報の届出
 *   items       [{ owner, required, status }]     チェックリスト
 * @returns {{key:string, blockers:string[], nextActors:string[]}}
 */
export function computeStage(f) {
  const x = stageFlags(f);
  if (x.cancelled) return { key: "complete", blockers: [], nextActors: [], cancelled: true };
  if (x.closed) return { key: "complete", blockers: [], nextActors: [] };

  // ① まだ社労士へ頼んでいない
  if (!x.ordered) {
    return { key: "conditions", blockers: ["契約書の準備がまだです（入力して作る・作成済みPDFを使う・作成を依頼する）"], nextActors: ["admin"] };
  }

  // ② 社労士が確認中（依頼中／書面は届いたが発行前）
  if (!x.issued) {
    return {
      key: "advisor_review",
      blockers: [x.orderUploaded ? "書面は届いています。発行がまだです" : "社労士の確認待ちです"],
      nextActors: ["advisor"],
    };
  }

  // ③ 本人の締結待ち（署名か、誓約書等の同意のどちらかが残っている）
  if (!x.signed || !x.consentsOk) {
    const b = [];
    if (!x.signed) b.push(x.noticePath ? "労働条件通知書の確認がまだです" : "労働条件通知書の締結がまだです");
    if (!x.consentsOk) b.push("誓約書・同意の確認がまだです");
    return { key: "signing", blockers: b, nextActors: ["employee"] };
  }

  // ④ 入社情報・書類・社内準備
  const b = [];
  const who = new Set();
  if (!x.profileSubmitted) { b.push("入社情報の入力がまだです"); who.add("employee"); }
  if (x.employeeOpen) {
    b.push(`書類の提出が ${x.employeeOpen} 件残っています`);
    who.add("employee");
  }
  // オリエンテーション（会社説明・社内ルール等の「確認済み」）。
  // 事実が渡されなかった（表が無い・読めない）ときは、止めない
  if (!x.orientationOk) {
    b.push("オリエンテーションの確認がまだです");
    who.add("employee");
  }
  if (x.internalOpen) {
    b.push(`社内準備が ${x.internalOpen} 件残っています`);
    who.add("admin");
  }
  if (b.length) return { key: "intake", blockers: b, nextActors: [...who] };

  // ⑤ 全部そろった
  return { key: "complete", blockers: [], nextActors: [] };
}

/** 段階の番号（1〜5）。進捗バーに使う */
export const stageIndex = (key) => stageOf(key).n;

/**
 * 進捗率。段階だけで出すと ④ の中の進みが見えないので、
 * ④ の中は「本人の書類＋社内準備」の消化で刻む
 */
export function progressPct(stageKey, items = []) {
  const n = stageIndex(stageKey);
  if (n >= 5) return 100;
  if (n < 4) return Math.round(((n - 1) / 5) * 100);
  const all = items.filter((i) => i.owner !== "employee" || i.required !== false);
  const done = all.filter((i) => ["done", "na", "submitted"].includes(i.status)).length;
  const inner = all.length ? done / all.length : 0;
  return Math.round((3 / 5 + inner / 5) * 100);
}

/** 入社日までの日数。過ぎていれば負 */
export function daysToStart(targetOn, today) {
  if (!targetOn) return null;
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${targetOn}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

/**
 * 一覧の上に出す5つの数。
 *
 *   入社予定      … 完了していない入社手続き
 *   社労士確認待ち … ②
 *   本人対応待ち   … ③、または ④ で本人に残りがある
 *   社内準備未完了 … 社内の項目が残っている（段階は問わない）
 *   手続き完了     … ⑤
 *
 * 重なりは許す（本人対応待ちで、かつ社内準備も未完了、はふつうにある）。
 * 「足すと入社予定になる」ような数ではない。
 */
export function kpiOf(rows) {
  const list = (rows || []).filter((r) => r.kind === "onboarding" && !r.cancelled);
  const at = (k) => list.filter((r) => r.stage === k).length;
  return {
    planned: list.filter((r) => r.stage !== "complete").length,
    advisor: at("advisor_review"),
    employee: list.filter((r) => r.stage === "signing"
      || (r.stage === "intake" && (r.nextActors || []).includes("employee"))).length,
    prep: list.filter((r) => r.stage !== "complete" && r.internalOpen > 0).length,
    complete: at("complete"),
  };
}

/** 一覧の「何が止まっているか」を1行にする */
export function stuckLine(r) {
  if (r.stage === "complete") return "";
  const b = r.blockers?.[0] || "";
  const who = stageOf(r.stage).actorLabel;
  return b ? `${who}：${b}` : who;
}
