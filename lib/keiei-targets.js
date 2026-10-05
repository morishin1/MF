// 経営ハブ（/keiei ホーム）の、月ごとの目標（KGI・KPI）。
//
// ■ これは「コード内の一時設定」
//   目標を保存する表（DB）は、Phase 1 では足さない（2026-10 の経営方針 §12）。
//   月が変わったら・目標を確定したら、ここを書き換えて出し直す。表に無い月は、目標の欄を出さない。
//   値は 2026-10-05 の経営方針（EIGHT 2026年10月 keiei 統合戦略）の「目標案」。実績ではない。確定前に調整する。
//
// ■ 実績の数え方（measure）
//   実績は Sales などの正本から、/api/keiei が毎回数える（lib/keiei-sales.js）。ここには書かない。
//   数え方が決まっていない・記録が無いものは measure を付けず、reason を出す（0 と出さない）。

/** 担当者別の欄に出す短い言い方（長い理由は、押さなくても見える title に回す） */
export const UNMEASURED_SHORT = {
  effective: "定義未決", key: "定義未決", pc: "未接続", ses: "未接続",
  diagnosis: "記録なし", region: "記録なし", hearing: "記録なし", referral: "記録なし",
  corp: "定義未決", ops: "未計測", pipeline: "定義未決",
};

/** 実績を数えられない理由（画面にそのまま出す） */
export const UNMEASURED = {
  effective: "定義未決（有効企業の条件を Sales で数えられる形に決めたあとで集計します）",
  key: "定義未決（本命案件の判定条件を決めたあとで集計します）",
  diagnosis: "未計測（AI/DX診断を Sales に記録する項目が、まだありません）",
  region: "未計測（地域接点を区別して記録していません）",
  hearing: "未計測（ヒアリングを区別して記録していません）",
  pc: "未接続（PC/IT機器の販売データは、このシステムに接続していません）",
  corp: "未計測（法人顧客の数え方が未決です）",
  referral: "未計測（診断送客の記録が、まだありません）",
  ops: "未計測（数え方が未決です）",
  pipeline: "未計測（有望の条件が未決です）",
  ses: "未接続（SESの稼働・売上は、このシステムで集計していません）",
};

export const TARGETS = {
  "2026-10": {
    label: "2026年10月",
    note: "目標は 2026-10-05 の経営方針の目標案です（確定前に調整します）。",
    // 全社の営業ファネル（4,000接触 → 100有効企業 → 30商談 → 15提案 → 10有料契約 → 3本命案件）
    funnel: [
      { key: "contact", label: "接触", target: 4000, unit: "件" },
      { key: "effective", label: "有効企業", target: 100, unit: "社" },
      { key: "meeting", label: "商談", target: 30, unit: "件" },
      { key: "proposal", label: "提案", target: 15, unit: "件" },
      { key: "won", label: "有料契約", target: 10, unit: "件" },
      { key: "key", label: "本命案件", target: 3, unit: "件" },
    ],
    // 計画上の転換率（%）。前の段階 → この段階
    plannedRates: { effective: 2.5, meeting: 30, proposal: 50, won: 67, key: 30 },
    // PC/IT機器販売（チームKGI）
    pc: { label: "PC/IT機器売上", target: 10000000 },
    // 担当別。name は名簿（社員の表示名）に含まれる姓。KPI は3つまで
    people: [
      { name: "山内", role: "地方創生・甲佐町周辺", kpis: [
        { label: "地域接点", target: 30, unit: "社", reason: "region" },
        { label: "診断", target: 5, unit: "社", reason: "diagnosis" },
        { label: "有料化", target: 1, unit: "社", measure: "won" },
      ] },
      { name: "中村", role: "広域の新規アタック", kpis: [
        { label: "接触", target: 2000, unit: "件", measure: "contact" },
        { label: "有効企業", target: 40, unit: "社", reason: "effective" },
        { label: "商談", target: 12, unit: "件", measure: "meeting" },
      ] },
      { name: "藤本", role: "Revenue・AI/DX診断・提案", kpis: [
        { label: "診断", target: 30, unit: "件", reason: "diagnosis" },
        { label: "提案", target: 15, unit: "件", measure: "proposal" },
        { label: "提案率", target: 50, unit: "%", measure: "proposal_rate" },
      ] },
      { name: "池永", role: "クロージング・契約・SES", kpis: [
        { label: "有料契約（全社）", target: 10, unit: "件", measure: "won_all" },
        { label: "本命案件（全社）", target: 3, unit: "件", reason: "key" },
        { label: "提案後7日超の停滞（全社）", target: 0, unit: "件", measure: "stalled_all", lowerIsBetter: true },
      ] },
      { name: "工藤", role: "PC販売・法人営業", kpis: [
        { label: "PC/IT機器売上（チーム）", target: 10000000, unit: "円", reason: "pc" },
        { label: "法人顧客", target: 20, unit: "社", reason: "corp" },
        { label: "DX診断送客", target: 10, unit: "社", reason: "referral" },
      ] },
      { name: "今福", role: "EC/PCの運営・兵站", kpis: [
        { label: "発送遅延", target: 0, unit: "件", reason: "pc", lowerIsBetter: true },
        { label: "顧客情報のCRM登録", target: 100, unit: "%", reason: "ops" },
      ] },
      { name: "魚住", role: "外部調整・イベント", kpis: [
        { label: "進行中の案件・イベント集客・商談創出", target: null, unit: "", reason: "ops" },
      ] },
      { name: "野澤", role: "全社BizOps/PMO", kpis: [
        { label: "期限超過のタスク（全社）", target: 0, unit: "件", measure: "tasks_overdue", lowerIsBetter: true },
        { label: "担当不明のタスク（全社）", target: 0, unit: "件", measure: "tasks_unassigned", lowerIsBetter: true },
        { label: "SOP化・AI/外部化", target: 8, unit: "件", reason: "ops" },
      ] },
    ],
  },
};

/** その月の目標。無ければ null（目標の欄を出さない） */
export const targetsOf = (month) => TARGETS[month] || null;
