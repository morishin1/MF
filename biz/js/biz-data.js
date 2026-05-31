// DriveKeiri - 法人向けモックデータ
// 株式会社山田製作所 の視点でシナリオを作成

const BIZ_COMPANY = {
  id: "c001",
  name: "株式会社山田製作所",
  representative: "山田 太郎",
  email: "yamada@yamada-seisakusho.co.jp",
  tax_firm: "さくら会計事務所",
  tax_adviser: "佐藤 花子 税理士",
  subscription: "DriveKeiri スタンダード",
  connected_date: "2025年10月",
  logo_color: "#2d5282"
};

// Google Drive 連携状況
const DRIVE_CONFIG = {
  connected: true,
  email: "keiri@yamada-seisakusho.co.jp",
  root_folder: "DriveKeiri - 山田製作所",
  last_sync: "2026年4月14日 15:42",
  auto_sync: true,
  folders: [
    { id: "f01", name: "📥 受信トレイ", path: "/DriveKeiri/受信トレイ", count: 3, description: "スキャンした書類をここに入れるだけ" },
    { id: "f02", name: "✅ 処理済（請求書）", path: "/DriveKeiri/済/請求書/2026-03", count: 18, description: "AIが自動で整理した請求書" },
    { id: "f03", name: "✅ 処理済（領収書）", path: "/DriveKeiri/済/領収書/2026-03", count: 42, description: "AIが自動で整理した領収書" },
    { id: "f04", name: "✅ 処理済（銀行明細）", path: "/DriveKeiri/済/銀行明細/2026-03", count: 4, description: "銀行明細（AIが仕訳済）" },
    { id: "f05", name: "✅ 処理済（給与関連）", path: "/DriveKeiri/済/給与/2026-03", count: 3, description: "給与明細等" },
    { id: "f06", name: "❓ 確認が必要", path: "/DriveKeiri/確認待ち", count: 2, description: "AIから質問が届いている書類" }
  ]
};

// 今月の統計
const BIZ_STATS = {
  period: "2026年3月",
  total_docs: 72,
  auto_processed: 65,
  needs_check: 2,  // 法人の確認待ち
  tax_review: 5,   // 税理士確認待ち
  completed: 65,
  time_saved_hours: 14,
  cost_saved_yen: 28000
};

// 書類一覧（ステータス別）
// ステータス: receiving(受信) / reading(読取中) / creating(仕訳生成中) / asking(質問中) / waiting(税理士確認) / done(完了)
const BIZ_DOCUMENTS = [
  {
    id: "d101",
    name: "請求書_山田電機_2026年3月分.pdf",
    type: "invoice",
    type_label: "請求書",
    sender: "山田電機株式会社",
    amount: 248000,
    uploaded_at: "2026-04-14 14:22",
    status: "done",
    progress: 100,
    ai_comment: "仕入（山田電機）として仕訳しました",
    journal: { debit: "仕入高", credit: "買掛金", amount: 248000 }
  },
  {
    id: "d102",
    name: "領収書_タクシー_田中.jpg",
    type: "receipt",
    type_label: "領収書",
    sender: "日本交通",
    amount: 3200,
    uploaded_at: "2026-04-14 14:18",
    status: "done",
    progress: 100,
    ai_comment: "旅費交通費として仕訳しました",
    journal: { debit: "旅費交通費", credit: "現金", amount: 3200 }
  },
  {
    id: "d103",
    name: "AWS請求書_2026-03.pdf",
    type: "invoice",
    type_label: "請求書",
    sender: "Amazon Web Services",
    amount: 42800,
    uploaded_at: "2026-04-14 13:55",
    status: "done",
    progress: 100,
    ai_comment: "通信費（クラウドサービス）として仕訳しました",
    journal: { debit: "通信費", credit: "未払金", amount: 42800 }
  },
  {
    id: "d104",
    name: "請求書_広告代理店_3月.pdf",
    type: "invoice",
    type_label: "請求書",
    sender: "株式会社エクスアド",
    amount: 340000,
    uploaded_at: "2026-04-14 13:40",
    status: "waiting",
    progress: 85,
    ai_comment: "仕訳候補を作成しました。税理士の確認待ちです。",
    journal: { debit: "広告宣伝費", credit: "未払金", amount: 340000 }
  },
  {
    id: "d105",
    name: "銀行明細_みずほ銀行_3月.pdf",
    type: "bank",
    type_label: "銀行明細",
    sender: "みずほ銀行",
    amount: null,
    uploaded_at: "2026-04-14 13:25",
    status: "waiting",
    progress: 80,
    ai_comment: "58件の取引を読み取りました。うち2件について税理士確認中です。",
    journal: null
  },
  {
    id: "d106",
    name: "領収書_取引先会食.jpg",
    type: "receipt",
    type_label: "領収書",
    sender: "和食処たけうち",
    amount: 28600,
    uploaded_at: "2026-04-14 12:10",
    status: "waiting",
    progress: 85,
    ai_comment: "交際費として仕訳候補を作成。税理士の確認待ちです。",
    journal: { debit: "交際費", credit: "現金", amount: 28600 }
  },
  {
    id: "d107",
    name: "不明書類_001.pdf",
    type: "unknown",
    type_label: "要確認",
    sender: "ABCコンサル株式会社",
    amount: 550000,
    uploaded_at: "2026-04-14 11:45",
    status: "asking",
    progress: 60,
    ai_comment: "初めての取引先のため、内容の確認が必要です。",
    journal: null,
    question_id: "q001"
  },
  {
    id: "d108",
    name: "請求書_山田電機_2026年2月分.pdf",
    type: "invoice",
    type_label: "請求書",
    sender: "山田電機株式会社",
    amount: 315000,
    uploaded_at: "2026-04-10 16:32",
    status: "done",
    progress: 100,
    ai_comment: "仕入（山田電機）として仕訳しました",
    journal: { debit: "仕入高", credit: "買掛金", amount: 315000 }
  },
  {
    id: "d109",
    name: "給与明細_2026年3月_山田.pdf",
    type: "salary",
    type_label: "給与明細",
    sender: "社内発行",
    amount: null,
    uploaded_at: "2026-04-10 10:15",
    status: "done",
    progress: 100,
    ai_comment: "給与関連書類として保管しました（仕訳不要）",
    journal: null
  },
  {
    id: "d110",
    name: "新しいスキャン_2026041501.pdf",
    type: "unknown",
    type_label: "読み取り中",
    sender: "確認中",
    amount: null,
    uploaded_at: "2026-04-15 09:02",
    status: "reading",
    progress: 30,
    ai_comment: "AIが書類を読み取っています...",
    journal: null
  },
  {
    id: "d111",
    name: "新しいスキャン_2026041502.pdf",
    type: "unknown",
    type_label: "判別中",
    sender: "確認中",
    amount: null,
    uploaded_at: "2026-04-15 09:03",
    status: "creating",
    progress: 55,
    ai_comment: "書類の種類を判別しています...",
    journal: null
  },
  {
    id: "d112",
    name: "領収書_コンビニ_3月.jpg",
    type: "receipt",
    type_label: "領収書",
    sender: "セブンイレブン",
    amount: 1840,
    uploaded_at: "2026-04-14 10:08",
    status: "done",
    progress: 100,
    ai_comment: "消耗品費として仕訳しました",
    journal: { debit: "消耗品費", credit: "現金", amount: 1840 }
  }
];

// AIからの質問（法人に届く確認事項）
const AI_QUESTIONS = [
  {
    id: "q001",
    doc_id: "d107",
    doc_name: "ABCコンサル_請求書_202603.pdf",
    created_at: "2026-04-14 11:50",
    status: "open",
    question: "<b>ABCコンサル株式会社</b>からの請求書 <b>550,000円</b> を受け取りました。初めての取引先のため、どのような内容か教えてください。",
    detail: "請求書には「コンサルティング費用」と記載されていますが、具体的な内容（社内研修、業務改善支援など）によって勘定科目が変わります。",
    options: [
      { id: "a", label: "経営コンサルティング（顧問料）", hint: "→ 支払報酬として処理します" },
      { id: "b", label: "業務改善・システム導入支援", hint: "→ 支払手数料として処理します" },
      { id: "c", label: "社員研修・教育目的", hint: "→ 研修費として処理します" },
      { id: "d", label: "その他（自由記述で教えてください）", hint: "→ 税理士に確認します" }
    ]
  },
  {
    id: "q002",
    doc_id: "d113",
    doc_name: "領収書_家電量販店_33000円.jpg",
    created_at: "2026-04-13 16:25",
    status: "open",
    question: "ビックカメラで <b>33,000円</b> の領収書を受け取りました。購入品は <b>事務用PC周辺機器</b> のようですが、用途を教えてください。",
    detail: "金額が10万円以下なので消耗品費として処理できますが、用途によって勘定科目が変わる場合があります。",
    options: [
      { id: "a", label: "事務所で使う消耗品・備品", hint: "→ 消耗品費として処理します" },
      { id: "b", label: "社員個人への貸与品", hint: "→ 福利厚生費として処理します" },
      { id: "c", label: "顧客への贈答品", hint: "→ 交際費として処理します" }
    ]
  }
];

// 月次レポートプレビュー（税理士から届いたもの）
const BIZ_REPORT_STATUS = {
  period: "2026年3月",
  status: "delivered", // pending / preparing / delivered
  delivered_at: "2026-04-14 16:30",
  tax_message: "3月は売上が前月から大きく回復し、良い形で締めくくれました。広告費が増えているので、次回の面談で効果を一緒に見ていきましょう。"
};

// ユーティリティ
function fmtYen(n) {
  if (n === null || n === undefined) return "-";
  const sign = n < 0 ? "△" : "";
  return sign + Math.abs(n).toLocaleString("ja-JP") + "円";
}

function fmtYenShort(n) {
  if (n === null || n === undefined) return "-";
  const sign = n < 0 ? "△" : "";
  const abs = Math.abs(n);
  if (abs >= 100000000) return sign + (abs/100000000).toFixed(1) + "億円";
  if (abs >= 10000) return sign + (abs/10000).toFixed(0) + "万円";
  return sign + abs.toLocaleString("ja-JP") + "円";
}

function fmtDate(str) {
  if (!str) return "-";
  return str.replace("-", "/").substring(5);
}

function statusLabel(s) {
  const map = {
    receiving: "受信しました",
    reading: "読み取り中",
    creating: "仕訳を作成中",
    asking: "確認をお願いしています",
    waiting: "税理士の確認待ち",
    done: "処理完了"
  };
  return map[s] || s;
}

function statusIcon(s) {
  const map = {
    receiving: "download",
    reading: "visibility",
    creating: "auto_awesome",
    asking: "help",
    waiting: "hourglass_top",
    done: "check_circle"
  };
  return map[s] || "more_horiz";
}

function docIcon(type) {
  const map = {
    invoice: "description",
    receipt: "receipt",
    bank: "account_balance",
    salary: "badge",
    contract: "gavel",
    unknown: "quiz"
  };
  return map[type] || "insert_drive_file";
}
