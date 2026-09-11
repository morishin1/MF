// 契約・電子署名の共通部分。差し込みの定義と、雛形の下書き。
//
// ■ 差し込みは、会社が既に持っている値だけ
//   本人に二度書かせないのが目的なので、名簿・入社フォーム・雇用契約から取る。
//   ここに無い項目は、雛形の本文に直接書いてもらう。
//   「差し込める項目を増やす」は、その値をどこかで必ず埋める、と決めてから。
//
// ■ 値が無いときは空にせず、印を残す
//   住所が未登録のまま契約書を作ると、住所の行だけ消えた契約書ができる。
//   それに気づかず送るほうが困るので、
//   埋まらなかった差し込みは【未入力：住所】として本文に残し、
//   送る前の確認で目に入るようにする。

/** 画面に出す書類の種類。最初に対応する4つ＋その他 */
export const DOC_KINDS = [
  { key: "employment", label: "労働条件通知書・雇用契約書" },
  { key: "pledge",     label: "誓約書・秘密保持誓約書" },
  { key: "equipment",  label: "PC・備品貸与契約書" },
  { key: "training",   label: "無限道場・研修関連書類" },
  { key: "other",      label: "その他" },
];
export const DOC_KIND_KEYS = DOC_KINDS.map((d) => d.key);
export const kindLabel = (k) => DOC_KINDS.find((d) => d.key === k)?.label || k;

/** 本人が押すチェックの文言。署名の記録にそのまま残すので、ここを唯一の出どころにする */
export const AGREE_TEXT = "内容を確認し、同意します。";

/**
 * 作成依頼（社労士に頼むとき）に伝える条件。
 *
 * ■ 入力欄を固定にした理由
 *   自由記入だけにすると、人によって書く項目が変わる。
 *   受け取る側は毎回どこに何が書いてあるか探すことになり、
 *   抜けていても抜けていると気づけない。
 *   労働基準法施行規則第5条で必ず書く項目を、そのまま欄にしてある。
 *
 * ■ システムは中身を解釈しない
 *   「賃金」に何を書くかは会社が決めること。文字列としてそのまま渡す。
 */
export const ORDER_FIELDS = [
  { key: "雇用区分",   placeholder: "正社員／契約社員／パート", required: true },
  { key: "契約期間",   placeholder: "期間の定めなし／2026-04-01〜2027-03-31", required: true },
  { key: "試用期間",   placeholder: "3か月（賃金は同条件）" },
  { key: "就業場所",   placeholder: "本社（変更の範囲：会社の定める事業所）", required: true },
  { key: "業務内容",   placeholder: "Web制作・ディレクション（変更の範囲：会社の定める業務）", required: true },
  { key: "就業時間",   placeholder: "9:00〜18:00（休憩60分）", required: true },
  { key: "休日・休暇", placeholder: "土日祝、年末年始。年次有給休暇は法定どおり", required: true },
  { key: "賃金",       placeholder: "月給 300,000円（固定残業代 45,000円／30時間ぶんを含む）", required: true },
  { key: "賃金の支払", placeholder: "月末締め・翌月25日払い／口座振込", required: true },
  { key: "社会保険",   placeholder: "健康保険・厚生年金・雇用保険・労災 加入" },
  { key: "退職",       placeholder: "定年65歳。自己都合退職は1か月前までに申し出" },
];
export const ORDER_FIELD_KEYS = ORDER_FIELDS.map((f) => f.key);

/** 作成依頼の状態。画面に出す言葉もここに置く */
export const ORDER_STATUS = [
  { key: "requested", label: "依頼中" },
  { key: "uploaded",  label: "確認待ち" },
  { key: "sent",      label: "署名依頼ずみ" },
  { key: "signed",    label: "締結ずみ" },
  { key: "cancelled", label: "取り消し" },
];
export const ORDER_STATUS_KEYS = ORDER_STATUS.map((s) => s.key);
export const orderStatusLabel = (k) =>
  ORDER_STATUS.find((s) => s.key === k)?.label || k;

/**
 * 依頼の条件を、送る前に整える。
 * 知らない鍵は落とす。画面が勝手な項目を足しても、記録には入らない
 */
export function normalizeConditions(input) {
  const out = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const key of ORDER_FIELD_KEYS) {
    const v = String(input[key] ?? "").trim();
    if (v) out[key] = v.slice(0, 500);
  }
  return out;
}

/** 必ず要る欄のうち、まだ空のもの。依頼を出す前の確認に使う */
export const missingConditions = (conditions) =>
  ORDER_FIELDS.filter((f) => f.required && !String(conditions?.[f.key] ?? "").trim())
    .map((f) => f.key);

/**
 * 差し込みできる項目。
 * key は本文に書く名前、from はどこから取るか（画面の説明に使う）
 */
export const MERGE_FIELDS = [
  { key: "氏名",         from: "名簿" },
  { key: "氏名カナ",     from: "入社フォーム" },
  { key: "部署",         from: "名簿" },
  { key: "役職",         from: "名簿" },
  { key: "雇用区分",     from: "名簿" },
  { key: "入社日",       from: "名簿" },
  { key: "メール",       from: "名簿" },
  { key: "郵便番号",     from: "入社フォーム" },
  { key: "住所",         from: "入社フォーム" },
  { key: "電話番号",     from: "入社フォーム" },
  { key: "生年月日",     from: "入社フォーム" },
  { key: "契約期間",     from: "雇用契約" },
  { key: "契約期間開始", from: "雇用契約" },
  { key: "契約期間終了", from: "雇用契約" },
  { key: "試用期間",     from: "雇用契約" },
  { key: "就業場所",     from: "雇用契約" },
  { key: "業務内容",     from: "雇用契約" },
  { key: "所定労働時間", from: "雇用契約" },
  { key: "所定労働日",   from: "雇用契約" },
  { key: "賃金",         from: "雇用契約" },
  { key: "賃金形態",     from: "雇用契約" },
  { key: "賃金額",       from: "雇用契約" },
  { key: "賃金備考",     from: "雇用契約" },
  { key: "会社名",       from: "組織設定" },
  { key: "今日",         from: "自動" },
];

// YYYY-MM-DD をそのまま読む。
//
// Date を通すと、getFullYear() などが動いているサーバの時間帯で返ってくる。
// Vercel は UTC なので、+09:00 を付けて作った 4月1日が 3月31日として出る。
// 日付だけの値に時刻の計算を挟む理由が無いので、文字列のまま組み立てる。
const jp = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d ?? ""));
  if (!m) return null;
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`;
};
/** その時刻の、日本時間での YYYY-MM-DD */
const jstDay = (t) =>
  new Date((t ? new Date(t) : new Date()).getTime() + 9 * 3600000)
    .toISOString().slice(0, 10);

const yen = (n) =>
  (n === null || n === undefined || n === "" ? null : `${Number(n).toLocaleString("ja-JP")}円`);

/**
 * 差し込みに使う値をそろえる。
 *
 * @param {object} p { employee, profile, contract, companyName, today }
 * @returns {Record<string,string|null>}
 */
export function buildFields({ employee = {}, profile = {}, contract = {}, companyName = "", today = null }) {
  const from = jp(contract.period_from);
  const to = jp(contract.period_to);
  const period = contract.fixed_term === false ? "期間の定めなし"
    : from ? `${from} 〜 ${to || "（終了日未定）"}`
      : null;

  return {
    "氏名": employee.display_name || null,
    "氏名カナ": profile.name_kana || null,
    "部署": employee.department || null,
    "役職": employee.position || null,
    "雇用区分": employee.employment_type || null,
    "入社日": jp(employee.joined_on),
    "メール": employee.email || null,
    "郵便番号": profile.postal_code || null,
    "住所": profile.address || null,
    "電話番号": profile.phone || null,
    "生年月日": jp(profile.birth_date),
    "契約期間": period,
    "契約期間開始": from,
    "契約期間終了": to,
    "試用期間": contract.probation_months ? `${contract.probation_months}か月` : null,
    "就業場所": contract.work_place || employee.work_location || null,
    "業務内容": contract.job_content || employee.initial_role || null,
    "所定労働時間": contract.work_hours || null,
    "所定労働日": contract.work_days || null,
    "賃金": contract.wage_amount
      ? `${contract.wage_type || ""} ${yen(contract.wage_amount)}`.trim()
        + (contract.wage_note ? `（${contract.wage_note}）` : "")
      : null,
    "賃金形態": contract.wage_type || null,
    "賃金額": yen(contract.wage_amount),
    "賃金備考": contract.wage_note || null,
    "会社名": companyName || null,
    // 「今日」だけは日時から。日本時間の日付にしてから文字列にする
    "今日": jp(jstDay(today)),
  };
}

/**
 * 本文に値を差し込む。
 *
 * @returns {{text:string, missing:string[]}} missing は埋まらなかった項目
 */
export function merge(body, fields) {
  const missing = new Set();
  const text = String(body ?? "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, rawKey) => {
    const key = String(rawKey).trim();
    if (!(key in fields)) return whole;          // 知らない項目はそのまま残す（打ち間違いに気づける）
    const v = fields[key];
    if (v === null || v === undefined || v === "") {
      missing.add(key);
      return `【未入力：${key}】`;
    }
    return String(v);
  });
  return { text, missing: [...missing] };
}

/** 本文に出てくる差し込みの一覧。定義に無いものも拾う（打ち間違いを見つけるため） */
export function usedFields(body) {
  const keys = new Set();
  for (const m of String(body ?? "").matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) keys.add(m[1].trim());
  return [...keys];
}

/** 期限切れか。状態としては持たず、見るときに数える */
export const isOverdue = (r, today = new Date()) =>
  Boolean(r && r.status === "sent" && r.due_on
    && r.due_on < new Date(today.getTime() + 9 * 3600000).toISOString().slice(0, 10));

/** 画面に出す状態。未署名 / 署名済 / 期限切れ / 取り消し */
export function statusOf(r, today = new Date()) {
  if (!r) return "unknown";
  if (r.status === "signed") return "signed";
  if (r.status === "cancelled") return "cancelled";
  return isOverdue(r, today) ? "overdue" : "sent";
}

/**
 * 雛形の下書き。
 *
 * ■ そのままでは使えない
 *   条文の中身は会社が決めるもので、システムが決めるものではない。
 *   ここにあるのは「どの項目を書く欄があるか」の骨組みで、
 *   金額や期間は差し込み、それ以外は会社が書き足す前提。
 *   画面にも、社労士の確認を受けてから使うよう書いてある。
 */
export const STARTERS = {
  employment: {
    name: "労働条件通知書 兼 雇用契約書",
    body: `{{会社名}}（以下「会社」という。）と {{氏名}}（以下「本人」という。）は、
以下のとおり労働条件を確認し、雇用契約を締結する。

第1条（契約期間）
{{契約期間}}
試用期間　{{試用期間}}

第2条（就業場所）
{{就業場所}}

第3条（業務内容）
{{業務内容}}

第4条（所定労働時間・休日）
所定労働時間　{{所定労働時間}}
所定労働日　　{{所定労働日}}

第5条（賃金）
{{賃金}}
賃金の締切日・支払日、支払方法、昇給、賞与、退職金については就業規則の定めによる。

第6条（休暇）
年次有給休暇その他の休暇は、労働基準法および就業規則の定めによる。

第7条（退職・解雇）
退職および解雇に関する事項は、就業規則の定めによる。

第8条（その他）
本契約に定めのない事項は、就業規則および関係法令の定めるところによる。
就業規則は社内文書（mf.8grp.co.jp）でいつでも閲覧できる。

交付日　{{今日}}
本人　　{{氏名}}
住所　　{{住所}}`,
  },

  pledge: {
    name: "誓約書 兼 秘密保持誓約書",
    body: `{{会社名}} 御中

私 {{氏名}} は、貴社に入社するにあたり、以下の事項を誓約します。

1（秘密保持）
在職中および退職後においても、貴社の営業上・技術上の秘密、顧客・取引先に
関する情報、その他貴社が秘密として管理する情報を、貴社の許可なく
第三者に開示・漏洩せず、また業務以外の目的で使用しません。

2（個人情報）
業務上知り得た個人情報を、法令および貴社の定めに従って取り扱います。

3（成果物の権利）
業務上作成した著作物その他の成果物に関する権利が、貴社に帰属することを
確認します。

4（会社の物品）
貸与を受けた物品・データを、業務以外の目的で使用せず、
退職時にはすべて返還します。

5（法令・社内ルールの遵守）
法令、就業規則、その他貴社の定めるルールを守って業務にあたります。

6（違反した場合）
本誓約に違反した場合、就業規則に基づく処分および損害賠償の責任を
負うことを確認します。

{{今日}}
氏名　{{氏名}}
住所　{{住所}}`,
  },

  equipment: {
    name: "PC・備品貸与契約書",
    body: `{{会社名}}（以下「会社」という。）は、{{氏名}}（以下「本人」という。）に対し、
業務のため以下の物品を貸与する。本人は以下の条件に同意する。

第1条（貸与する物品）
※ 機種・管理番号・付属品は、貸与時の一覧（アカウント・貸与品）による。

第2条（使用の範囲）
貸与された物品は、業務にのみ使用する。
私的な利用、第三者への貸与・譲渡はしない。

第3条（管理）
持ち出し・保管にあたっては、紛失・盗難・破損のないよう注意する。
社外に持ち出す場合は、画面ロックと暗号化を有効にしておく。

第4条（ソフトウェア）
会社の許可なくソフトウェアを導入せず、業務データを許可のない
外部サービスに保存しない。

第5条（紛失・故障）
紛失・盗難・故障が生じたときは、直ちに会社に連絡する。
本人の故意または重大な過失による場合、会社は費用の負担を求めることがある。

第6条（返還）
退職時、または会社が求めたときは、速やかに返還する。
返還にあたり、業務データを私物の機器に残さない。

{{今日}}
本人　{{氏名}}（{{部署}}）`,
  },

  training: {
    name: "研修受講に関する確認書",
    body: `{{会社名}} 御中

私 {{氏名}} は、貴社が提供する研修（無限道場を含む。以下「本研修」という。）の
受講にあたり、以下の事項を確認します。

1（目的）
本研修は、業務に必要な知識と技能を身につけることを目的とするものです。

2（教材の取扱い）
本研修で提供される教材・動画・資料の著作権は貴社または権利者に帰属します。
複製、転載、第三者への提供、社外への持ち出しは行いません。

3（アカウント）
付与されたアカウントを他人と共有せず、貸与もしません。

4（受講記録）
受講の記録（進捗・テストの結果）が、育成および評価の参考として
用いられることを確認します。

5（費用）
※ 会社が費用を負担する研修の範囲、および受講後の取扱いについては、
   別途会社の定めによります。

{{今日}}
氏名　{{氏名}}（{{部署}}）`,
  },
};
