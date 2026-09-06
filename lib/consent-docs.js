// 入社時に電子確認・同意してもらう3つの書類。
//
// ■ 紙の署名をやめて、チェック1つにした
//   氏名・日付・手書きサインの欄は無い。
//   誰が同意したかはログインしているアカウントで分かるし、
//   いつ同意したかはシステムが記録する。
//   本人に書かせるのは、システムが知っていることの写しでしかなかった。
//
// ■ 文書はここが正（バージョン付き）
//   本文をコードに置き、DB（gw_consent_docs）には起動時に写す。
//   Word の原本は docs/consent/ にあるが、同意の対象になるのはこの本文。
//   Word と本文がずれたら、ここを直してバージョンを上げる。
//
// ■ バージョンの上げ方
//   major: true  … 内容が実質的に変わった。全員に読み直して再同意してもらう
//   major: false … 言い回しの修正など。以前のバージョンへの同意をそのまま認める
//   どちらでも「誰がどの版にいつ同意したか」は残る（同意の行は消さない）。
//
// ■ 労働条件通知書・雇用契約は、ここに入れない
//   あれは会社と本人が合意して決めるもので、「読みました」で済ませてよいものではない。
//   別の流れ（gw_contracts）で扱う。

export const COMPANY = "株式会社エイト";

/** 文末に置く、電子確認の説明。紙の署名欄の代わり */
export const E_CONFIRM_NOTE =
  "電子確認について\n"
  + "本書の内容を確認のうえ、社内システム上の「読みました。内容に同意します」にチェックすることで、"
  + "本書の内容への確認・同意を行います。"
  + "確認・同意した日時および対象文書のバージョンは会社のシステムに記録されます。";

export const CONSENT_DOCS = [
  {
    key: "pledge",
    title: "誓約書",
    subtitle: "機密情報・個人情報・成果物の取扱いに関する確認",
    summary: "会社・お客様・取引先の情報を適切に取り扱うための基本的な約束です。",
    version: "1.0",
    major: true,
    body: [
      "私は、株式会社エイトで業務を行うにあたり、以下の事項を遵守します。",
      "",
      "・会社、お客様、取引先、従業員等に関する機密情報・個人情報・業務情報を、業務上必要な場合を除き、第三者に開示・提供しません。",
      "・これらの情報を、会社の許可なく私物の端末・個人アカウント等へ保存、複製、持ち出ししません。",
      "・SNS、口コミサイト、ブログ、動画サイト、掲示板等を含め、会社やお客様の非公開情報を外部へ投稿・公開しません。",
      "・上記の秘密保持義務は、退職後も継続して守ります。",
      "・業務上作成した資料、データ、プログラム、デザイン、文章、ノウハウその他の成果物の権利は、法令・就業規則・契約等の定めに従い、会社に帰属または会社へ移転するものとして取り扱います。",
      "・退職時には、会社から貸与された機器・資料・データ等を返却し、会社の情報を手元に残しません。",
      "",
      "※詳細な取扱いは、就業規則、情報セキュリティ関連規程、機密保持に関する社内規程その他会社が定めるルールに従います。",
    ].join("\n"),
  },
  {
    key: "privacy",
    title: "個人情報の取扱い",
    subtitle: "従業員の個人情報の利用目的・提供等に関する確認",
    summary: "入社・雇用管理に必要な範囲で個人情報をお預かりし、適切に管理します。",
    version: "1.0",
    major: true,
    body: [
      "株式会社エイトは、入社手続き等で取得した従業員の個人情報を、主に次の目的で利用します。",
      "",
      "・採用、入社、配置、異動、評価、教育・育成その他の人事・雇用管理",
      "・勤怠、労働時間、休暇その他の勤務管理",
      "・給与・賞与の支払い、年末調整、源泉徴収その他の給与・税務手続き",
      "・社会保険・雇用保険その他の法令上必要な手続き",
      "・福利厚生、健康管理、安全管理、社内システム等の利用管理",
      "・業務上必要な連絡、業務分担、記録・報告等の業務管理",
      "",
      "第三者への提供等",
      "社会保険・労務・税務その他の手続きを行うため、必要な範囲で社会保険労務士、行政機関、健康保険関係機関、金融機関その他手続きに必要な関係先へ個人情報を提供する場合があります。",
      "",
      "会社は、取得した個人情報を適切に管理し、法令または本人の同意に基づく場合を除き、利用目的の達成に必要な範囲を超えて取り扱いません。",
      "",
      "※個人情報のより詳細な取扱い、開示等の請求、相談窓口等は、会社が定める個人情報保護に関する規程・通知に従います。",
    ].join("\n"),
  },
  {
    key: "rules",
    title: "社内ルール確認書",
    subtitle: "就業規則・情報の取扱い等に関する確認",
    summary: "社内ルールは、安全かつ円滑に働くための共通ルールです。",
    version: "1.0",
    major: true,
    body: [
      "私は、株式会社エイトで働くにあたり、会社が定める以下のルールを確認し、これに従って業務を行います。",
      "",
      "・就業規則および雇用・勤務に関するルール",
      "・情報セキュリティ、機密情報および個人情報の取扱いルール",
      "・会社貸与のPC・スマートフォン・アカウント等の利用ルール",
      "・SNS・インターネット利用に関するルール",
      "・社内設備・スペース・備品等の利用ルール",
      "・その他、会社が業務上必要として定める規程・運用ルール",
      "",
      "ルールの確認方法",
      "最新の社内ルール・就業規則・各種規程は、社内システムの「社内情報（ライブラリ）」からいつでも確認できます。内容が更新された場合は、会社からのお知らせを確認します。",
      "",
      "※本確認書は主要なルールの確認を目的としたものです。詳細は、社内情報（ライブラリ）に掲載された最新の規程・ルールを確認してください。",
    ].join("\n"),
  },
];

export const CONSENT_KEYS = CONSENT_DOCS.map((d) => d.key);

/** 同意の対象になる全文。本文＋電子確認の説明 */
export const fullText = (doc) => `${doc.body}\n\n${E_CONFIRM_NOTE}`;

/**
 * コードにある版を DB に写す。無い版だけ足す。
 * 起動ごとに走らせてよい（同じ版は2回入らない）。
 */
export async function ensureConsentDocs(sb, tenantId) {
  const { data: have } = await sb.from("gw_consent_docs")
    .select("doc_key, version").eq("tenant_id", tenantId);
  const seen = new Set((have || []).map((d) => `${d.doc_key}:${d.version}`));

  const rows = CONSENT_DOCS
    .filter((d) => !seen.has(`${d.key}:${d.version}`))
    .map((d) => ({
      tenant_id: tenantId,
      doc_key: d.key,
      title: d.title,
      subtitle: d.subtitle,
      summary: d.summary,
      body: fullText(d),
      version: d.version,
      major: d.major,
      status: "active",
    }));
  if (rows.length) await sb.from("gw_consent_docs").insert(rows);

  // 同じ doc_key で新しい版が入ったら、古い版は retired にする。
  // 同意の記録は版ごとに残るので、消してはいない
  for (const d of CONSENT_DOCS) {
    await sb.from("gw_consent_docs")
      .update({ status: "retired" })
      .eq("tenant_id", tenantId).eq("doc_key", d.key).neq("version", d.version)
      .eq("status", "active");
  }
}

/**
 * その人の同意の状態。
 *
 * @param {Array} docs     gw_consent_docs（active）
 * @param {Array} consents gw_onboard_consents（その人の全部）
 * @returns 書類ごとに { agreed, agreedAt, agreedVersion, needsReconsent }
 */
export function consentState(docs, consents) {
  const byKey = new Map();
  for (const c of consents || []) {
    const list = byKey.get(c.kind) || [];
    list.push(c);
    byKey.set(c.kind, list);
  }

  return docs.map((d) => {
    const mine = (byKey.get(d.doc_key) || []).sort((a, b) => (a.agreed_at < b.agreed_at ? 1 : -1));
    const exact = mine.find((c) => c.version === d.version);
    const latest = mine[0] || null;

    // いまの版に同意済み → 済み。
    // 古い版にだけ同意している → 重要な改定なら読み直し、そうでなければ済み扱い
    const agreed = Boolean(exact) || (Boolean(latest) && !d.major);
    return {
      id: d.id, key: d.doc_key, title: d.title, subtitle: d.subtitle, summary: d.summary,
      version: d.version, body: d.body,
      agreed,
      agreedAt: (exact || latest)?.agreed_at || null,
      agreedVersion: (exact || latest)?.version || null,
      needsReconsent: Boolean(latest) && !exact && d.major,
    };
  });
}
