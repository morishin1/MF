// マイナンバーの「進み具合」だけを持つ。番号は持たない。
//
// ■ 決めたこと（2026-09）
//
//   グループウェアでは番号を持たない方針を維持する。
//   番号は社労士側で直接収集・管理する。
//   システムが持つのは「どこまで進んだか」だけ。
//
//     not_submitted        未提出
//     requested            提出依頼済み（社労士から本人へ案内した）
//     submitted_to_advisor 社労士提出済み（本人が社労士へ渡した）
//     confirmed            確認完了（社労士が確かめた）
//
// ■ 番号や確認書類は、この仕組みに入れない
//
//   マイナンバー確認書類のアップロード口も閉じる（api/onboarding/upload.js）。
//   「取扱注意」と書いて受け取るより、受け取らないほうが確実に安全。
//   番号法の安全管理措置は、見られる人を最小にすることそのもの。

export const MYNUMBER_STATES = [
  { key: "not_submitted",        label: "未提出",         who: "" },
  { key: "requested",            label: "提出依頼済み",   who: "社労士が本人へ案内" },
  { key: "submitted_to_advisor", label: "社労士提出済み", who: "本人が社労士へ提出" },
  { key: "confirmed",            label: "確認完了",       who: "社労士が確認" },
];
export const MYNUMBER_KEYS = MYNUMBER_STATES.map((s) => s.key);
export const mynumberLabel = (k) =>
  MYNUMBER_STATES.find((s) => s.key === (k || "not_submitted"))?.label || "未提出";

/** チェックリストの項目キー。この項目は「出したか」で判定しない */
export const MYNUMBER_ITEM_KEY = "doc_mynumber";
