// AI営業：送ってよい先かの判定（docs/ai-sales-agent-phase0.md §5.8）。
//
//   blocked       … 送らない。営業お断り・自動送信禁止・サポート専用・採用専用・拒否の記載、AI が禁止の記載を見つけた
//   manual_review … 担当者がフォームの受付目的と規約を確かめるまで、送信操作へ進めない（AI の判定の既定値）
//   ok_manual     … 担当者が確かめた（人の操作でだけ付く。AI・規則では付けない）
//
// 「禁止の記載が見つからない」ことだけでは送ってよいことにしない。だから AI・規則が付けるのは blocked か manual_review だけ。

const PROHIBIT = [
  { key: "no_sales", label: "営業お断りの記載", re: /(営業|セールス|売り込み|勧誘|広告|宣伝|営業目的)[^。\n]{0,25}(お断り|ご遠慮|禁止|受け付けておりません|受付しておりません|お受けしておりません|お控えください|固くお断り)/ },
  { key: "no_sales", label: "営業お断りの記載", re: /(営業|セールス)(メール|電話|のご連絡|に関するお問い合わせ)[^。\n]{0,15}(は)?(返信|回答|対応)(いたし|し)(かね|ません)/ },
  { key: "no_auto", label: "自動送信・機械的な送信の禁止", re: /(自動送信|自動で送信|自動的な送信|機械的な?送信|一斉送信|プログラムによる送信|ツールによる送信|クローラ|スクレイピング|ロボット)[^。\n]{0,25}(禁止|お断り|ご遠慮|お控え)/ },
  { key: "support_only", label: "既存顧客・サポート専用の窓口", re: /(既存|ご利用中|ご契約中|ご購入|会員)の?(お客様|お客さま|顧客|方)[^。\n]{0,20}(専用|のみ|限定|に限り)/ },
  { key: "support_only", label: "既存顧客・サポート専用の窓口", re: /(カスタマー)?サポート[^。\n]{0,10}(専用|のみ)/ },
  { key: "recruit_only", label: "採用専用の窓口", re: /(採用|求人|応募)[^。\n]{0,10}(専用|のみ受け付け|に関するお問い合わせのみ)/ },
];

/** 読んだページから禁止の記載を探す。見つけた文（前後つき）と出典を返す */
export function scanProhibitions(pages = []) {
  const hits = [];
  for (const p of pages) {
    for (const rule of PROHIBIT) {
      const m = String(p.text || "").match(rule.re);
      if (!m) continue;
      const at = m.index || 0;
      const quote = String(p.text).slice(Math.max(at - 20, 0), at + m[0].length + 20).replace(/\s+/g, " ");
      if (!hits.some((h) => h.key === rule.key && h.url === p.url)) hits.push({ key: rule.key, label: rule.label, quote, url: p.url });
    }
  }
  return hits;
}

/**
 * 判定。AI の結果（formPurpose・prohibition）と規則の結果を合わせる。どちらかが止めれば止める
 * @returns {{sendCheck:'blocked'|'manual_review', reasons:Array<{key:string,label:string,quote?:string,url?:string}>}}
 */
export function decideSendCheck({ hits = [], formPurpose = "unknown", aiProhibition = null, form = null } = {}) {
  const reasons = [...hits];
  if (formPurpose === "support_only" && !reasons.some((r) => r.key === "support_only")) reasons.push({ key: "support_only", label: "既存顧客・サポート専用の窓口（AIの判定）" });
  if (formPurpose === "recruit_only" && !reasons.some((r) => r.key === "recruit_only")) reasons.push({ key: "recruit_only", label: "採用専用の窓口（AIの判定）" });
  if (aiProhibition?.found) reasons.push({ key: "ai_prohibition", label: "営業・自動送信の禁止の記載（AIの判定）", quote: aiProhibition.quote || "", url: aiProhibition.url || "" });
  if (reasons.length) return { sendCheck: "blocked", reasons };

  const review = [{ key: "confirm", label: "フォームの受付目的と、営業・自動送信の禁止の記載が無いことを担当者が確認してください" }];
  if (!form) review.push({ key: "no_form_page", label: "問い合わせページを見つけられませんでした（サイトで確認してください）" });
  else {
    if (form.external) review.push({ key: "external_form", label: "外部のフォームサービスです（開いて受付目的を確認してください）" });
    if (form.hasForm === false) review.push({ key: "no_form", label: "問い合わせページにフォームがありません" });
    if (form.captcha) review.push({ key: "captcha", label: "CAPTCHA があります（自動操作はしません。人が送ります）" });
    if (form.login) review.push({ key: "login", label: "ログインが必要な可能性があります（越えて送りません）" });
  }
  if (formPurpose === "unknown") review.push({ key: "purpose_unknown", label: "フォームの受付目的が読み取れませんでした" });
  return { sendCheck: "manual_review", reasons: review };
}

export const SEND_CHECK_LABEL = {
  blocked: "送信不可",
  manual_review: "要確認（担当者が確認するまで送れません）",
  ok_manual: "確認済み（手動で送信できます）",
};
