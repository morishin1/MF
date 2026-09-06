// 集まった情報から、社労士への連絡用テキストと Slack の投稿文を組み立てる。
//
// ■ AIに書かせない
//   どちらも、必要な材料はすでに構造化されて手元にある。
//   AIを挟むと、文章はなめらかになるが、生年月日や口座番号を
//   書き換えてしまう可能性がゼロにならない。
//   社会保険の手続きに使う文面で、それは割に合わない。
//
//   組み立てた結果は画面に出して、人が読んでから渡す。
//   渡す前に、何を渡すかが見えている状態にする。
//
// ■ 社労士へ渡すものは、必要な範囲だけ
//   給与額・評価・日報は渡さない。
//   雇用保険と社会保険の資格取得届に要るものだけを並べる。
//   足りない項目は「（未入力）」と書いて、隠さない。
//   埋まっているように見える文面を渡すほうが危ない。
//
// ■ Slackには、本人が見せてよいものだけ
//   住所・生年月日・口座は入れない。
//   氏名・入社日・担当業務・本人からの一言だけ。

const jp = (d) => {
  if (!d) return "（未入力）";
  const [y, m, day] = String(d).split("-");
  return `${Number(y)}年${Number(m)}月${Number(day)}日`;
};

const or = (v, alt = "（未入力）") => {
  const s = String(v ?? "").trim();
  return s || alt;
};

/**
 * 社労士への連絡用テキスト。
 *
 * @param {object} p
 *   employee  gw_employees の行
 *   contract  gw_contracts の行（給与は使わない）
 *   profile   gw_onboard_profiles の行
 * @returns {{text:string, missing:Array<string>, ready:boolean}}
 */
export function advisorBrief({ employee, contract, profile }) {
  const pf = profile || {};
  const c = contract || {};

  // 資格取得届に要るもの。足りないものは隠さず並べる
  const need = [
    ["氏名（カナ）", pf.name_kana],
    ["生年月日", pf.birth_date],
    ["住所", pf.address],
    ["基礎年金番号", pf.pension_number],
    ["雇用保険被保険者番号", pf.employment_ins_number],
  ];
  const missing = need.filter(([, v]) => !String(v ?? "").trim()).map(([k]) => k);

  const weekly = c.weekly_hours ?? null;
  // 社会保険の加入は、週の所定労働時間が判断のいちばん大きな材料になる。
  // ここで判定はしない（要件は事業所規模でも変わる）。数字を並べて社労士に渡す
  const text = [
    "【入社の手続きをお願いします】",
    "",
    `氏名　　　　：${or(employee?.display_name)}`,
    `氏名（カナ）：${or(pf.name_kana)}`,
    `生年月日　　：${jp(pf.birth_date)}`,
    `住所　　　　：${or(pf.postal_code) === "（未入力）" ? "" : `〒${pf.postal_code} `}${or(pf.address)}`,
    `電話番号　　：${or(pf.phone)}`,
    "",
    "■ 雇用条件",
    `入社日　　　：${jp(employee?.joined_on || c.period_from)}`,
    `雇用区分　　：${or(c.contract_type || employee?.employment_type)}`,
    `契約期間　　：${c.fixed_term ? `${jp(c.period_from)} 〜 ${jp(c.period_to)}` : "期間の定めなし"}`,
    `週の所定労働時間：${weekly != null ? `${weekly} 時間` : "（未入力）"}`,
    `業務内容　　：${or(c.job_content || employee?.initial_role)}`,
    `勤務形態　　：${or(c.work_style || employee?.work_style, "指定なし")}`,
    "",
    "■ 保険の手続きに必要なもの",
    `基礎年金番号　　　　：${or(pf.pension_number)}`,
    `雇用保険被保険者番号：${or(pf.employment_ins_number)}`,
    `扶養家族　　　　　　：${pf.has_dependents === true ? or(pf.dependents_note, "あり（内訳は未入力）")
                        : pf.has_dependents === false ? "なし" : "（未入力）"}`,
    "",
    // 番号法の対象なので、この文面には載せない。渡し方も分けてもらう
    "※ マイナンバーはこの連絡には含めていません。別途、貴所の指定する方法でお送りします。",
    "※ 給与額は含めていません。必要でしたらお知らせください。",
    "",
    missing.length
      ? `【未入力】${missing.join(" / ")}\n本人に確認のうえ、追ってお送りします。`
      : "上記で手続きをお願いいたします。",
  ].join("\n");

  return { text, missing, ready: missing.length === 0 };
}

/**
 * Slack の投稿文。
 * 住所・生年月日・口座は入れない。入社日に社内へ流すためのもの
 */
export function slackPost({ employee, contract, profile, manager }) {
  const pf = profile || {};
  const role = contract?.job_content || employee?.initial_role || null;
  const scope = Array.isArray(contract?.work_scope) ? contract.work_scope : [];

  // 段落ごとに組み立ててから、空でないものだけを空行でつなぐ。
  // 行の配列を素通しでつなぐと、材料が無い行のところが詰まって読みにくくなる
  const blocks = [
    `:tada: 本日 ${jp(employee?.joined_on)} より、${or(employee?.display_name)} さんが入社しました！`,
    [
      role ? `担当：${role}` : "",
      scope.length ? `業務：${scope.join("・")}` : "",
      manager ? `相談先：${manager} さん` : "",
    ].filter(Boolean).join("\n"),
    pf.greeting ? `▼ ${or(employee?.display_name)} さんより\n${pf.greeting}` : "",
    "見かけたら、ぜひ声をかけてください。",
  ];

  return blocks.filter(Boolean).join("\n\n");
}
