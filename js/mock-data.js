// KessanPilot - モックデータ
// 3つの顧問先 + 事務所情報
// すべての数値は架空のデモ用

const FIRM = {
  name: "さくら会計事務所",
  owner: "山本 太郎 税理士",
  staff: 12,
  clients: 87
};

const CLIENTS = [
  {
    id: "c001",
    name: "株式会社山田製作所",
    industry: "製造業（金属加工）",
    staff: 28,
    revenue_yearly: 420000000,
    fiscal_month: 3,
    mf_connected: true,
    closing_status: "in_progress", // done / in_progress / pending
    closing_progress: 65,
    assigned: "佐藤 花子",
    alert_count: 3,
    avatar_color: "#2d5282"
  },
  {
    id: "c002",
    name: "株式会社グリーンカフェ",
    industry: "飲食業（カフェ3店舗）",
    staff: 24,
    revenue_yearly: 180000000,
    fiscal_month: 12,
    mf_connected: true,
    closing_status: "pending",
    closing_progress: 20,
    assigned: "鈴木 一郎",
    alert_count: 5,
    avatar_color: "#2f855a"
  },
  {
    id: "c003",
    name: "サンライズIT株式会社",
    industry: "IT・SaaS開発",
    staff: 18,
    revenue_yearly: 260000000,
    fiscal_month: 6,
    mf_connected: true,
    closing_status: "done",
    closing_progress: 100,
    assigned: "田中 美咲",
    alert_count: 0,
    avatar_color: "#b7791f"
  }
];

// 顧問先別の試算表・推移データ（当月=2026年3月）
const FINANCIAL_DATA = {
  c001: {
    client_id: "c001",
    period: "2026年3月",
    summary: {
      revenue: 38500000,
      revenue_prev: 32800000,
      revenue_prev_year: 35200000,
      gross_profit: 11200000,
      operating_profit: 2450000,
      operating_profit_prev: 1980000,
      operating_profit_prev_year: 2800000,
      fixed_cost: 8750000,
      cash: 52300000
    },
    trend: {
      months: ["2025/10", "2025/11", "2025/12", "2026/1", "2026/2", "2026/3"],
      revenue: [31200000, 33500000, 36800000, 30100000, 32800000, 38500000],
      gross_profit: [9200000, 9800000, 10900000, 8700000, 9500000, 11200000],
      operating_profit: [2100000, 2400000, 2800000, 1650000, 1980000, 2450000]
    },
    key_accounts: [
      { name: "売上高", current: 38500000, prev: 32800000, prev_year: 35200000 },
      { name: "売上原価", current: 27300000, prev: 23300000, prev_year: 24600000 },
      { name: "役員報酬", current: 1800000, prev: 1800000, prev_year: 1500000 },
      { name: "給与手当", current: 4200000, prev: 4100000, prev_year: 3900000 },
      { name: "地代家賃", current: 850000, prev: 850000, prev_year: 850000 },
      { name: "広告宣伝費", current: 520000, prev: 180000, prev_year: 210000 },
      { name: "支払手数料", current: 340000, prev: 320000, prev_year: 310000 }
    ]
  },
  c002: {
    client_id: "c002",
    period: "2026年3月",
    summary: {
      revenue: 14200000,
      revenue_prev: 16800000,
      revenue_prev_year: 15500000,
      gross_profit: 8900000,
      operating_profit: -420000,
      operating_profit_prev: 980000,
      operating_profit_prev_year: 1200000,
      fixed_cost: 9320000,
      cash: 8700000
    },
    trend: {
      months: ["2025/10", "2025/11", "2025/12", "2026/1", "2026/2", "2026/3"],
      revenue: [15200000, 16800000, 18500000, 15100000, 16800000, 14200000],
      gross_profit: [9500000, 10500000, 11800000, 9400000, 10500000, 8900000],
      operating_profit: [980000, 1350000, 2100000, 820000, 980000, -420000]
    },
    key_accounts: [
      { name: "売上高", current: 14200000, prev: 16800000, prev_year: 15500000 },
      { name: "売上原価", current: 5300000, prev: 6300000, prev_year: 5800000 },
      { name: "給与手当", current: 5200000, prev: 4800000, prev_year: 4200000 },
      { name: "地代家賃", current: 2200000, prev: 2200000, prev_year: 2000000 },
      { name: "水道光熱費", current: 480000, prev: 420000, prev_year: 380000 },
      { name: "広告宣伝費", current: 380000, prev: 220000, prev_year: 180000 }
    ]
  },
  c003: {
    client_id: "c003",
    period: "2026年3月",
    summary: {
      revenue: 24800000,
      revenue_prev: 23200000,
      revenue_prev_year: 19500000,
      gross_profit: 18200000,
      operating_profit: 4850000,
      operating_profit_prev: 4320000,
      operating_profit_prev_year: 3100000,
      fixed_cost: 13350000,
      cash: 68200000
    },
    trend: {
      months: ["2025/10", "2025/11", "2025/12", "2026/1", "2026/2", "2026/3"],
      revenue: [20500000, 21800000, 22400000, 22800000, 23200000, 24800000],
      gross_profit: [15200000, 16100000, 16500000, 16800000, 17200000, 18200000],
      operating_profit: [3400000, 3800000, 4100000, 4200000, 4320000, 4850000]
    },
    key_accounts: [
      { name: "売上高", current: 24800000, prev: 23200000, prev_year: 19500000 },
      { name: "売上原価", current: 6600000, prev: 6200000, prev_year: 5400000 },
      { name: "役員報酬", current: 2500000, prev: 2500000, prev_year: 2200000 },
      { name: "給与手当", current: 8800000, prev: 8500000, prev_year: 6800000 },
      { name: "地代家賃", current: 680000, prev: 680000, prev_year: 620000 },
      { name: "支払手数料", current: 1250000, prev: 1180000, prev_year: 920000 }
    ]
  }
};

// 月次締めチェック項目（AI検知）
const CLOSING_CHECKS = {
  c001: [
    {
      id: "chk1",
      severity: "high",
      category: "残高ズレ",
      title: "預金残高と帳簿残高に差異あり",
      description: "みずほ銀行普通預金の帳簿残高 12,450,300円 に対し、連携明細ベースの残高は 12,398,700円。差額 51,600円 の原因が未特定です。3/28の手数料計上漏れの可能性があります。",
      suggested_action: "3月下旬の未仕訳取引を確認してください。",
      source: "預金残高照合",
      amount: 51600,
      done: false
    },
    {
      id: "chk2",
      severity: "high",
      category: "長期滞留",
      title: "仮払金の長期未精算",
      description: "仮払金残高 380,000円のうち、2025年11月計上分 180,000円（出張費・佐々木様）が4ヶ月以上未精算のままです。",
      suggested_action: "担当者に精算書提出を依頼するか、当月中に経費計上をご検討ください。",
      source: "補助元帳分析",
      amount: 180000,
      done: false
    },
    {
      id: "chk3",
      severity: "mid",
      category: "異常値",
      title: "広告宣伝費が前月比+189%",
      description: "広告宣伝費が前月 180,000円 → 当月 520,000円 に増加。前年同月 210,000円 と比較しても大幅増です。新規施策の計上か、重複計上かご確認ください。",
      suggested_action: "請求書と取引内容を再確認してください。",
      source: "推移表異常値検知",
      amount: 340000,
      done: false
    },
    {
      id: "chk4",
      severity: "mid",
      category: "売掛金滞留",
      title: "株式会社△△商事の売掛金が3ヶ月滞留",
      description: "株式会社△△商事への売掛金 680,000円（2025/12計上）が回収されていません。",
      suggested_action: "顧問先に回収状況をヒアリングしてください。",
      source: "売掛金年齢表",
      amount: 680000,
      done: false
    },
    {
      id: "chk5",
      severity: "low",
      category: "締め項目",
      title: "減価償却費の月次按分未計上",
      description: "固定資産台帳に基づく月次按分 420,000円 が未計上です。",
      suggested_action: "月次減価償却を計上してください。",
      source: "固定資産台帳",
      amount: 420000,
      done: true
    },
    {
      id: "chk6",
      severity: "low",
      category: "締め項目",
      title: "社会保険料の未払計上確認",
      description: "当月分社会保険料 580,000円の未払金計上を確認してください。",
      suggested_action: "給与明細と照合してください。",
      source: "定期項目チェック",
      amount: 580000,
      done: true
    }
  ],
  c002: [
    {
      id: "chk1",
      severity: "high",
      category: "営業赤字",
      title: "当月営業損失の発生",
      description: "当月の営業損失 △420,000円 が発生しています。売上が前月比△15.5%と急減したことが主要因です。",
      suggested_action: "社長面談で原因ヒアリングと次月対策の議論を推奨します。",
      source: "月次試算表",
      amount: -420000,
      done: false
    },
    {
      id: "chk2",
      severity: "high",
      category: "未処理明細",
      title: "未仕訳の入出金が23件",
      description: "3/15以降のクレジットカード明細 23件（合計 287,500円）が未仕訳です。",
      suggested_action: "取引明細を仕訳候補ページで処理してください。",
      source: "MF連携状況",
      amount: 287500,
      done: false
    },
    {
      id: "chk3",
      severity: "high",
      category: "立替金",
      title: "立替経費の長期滞留",
      description: "店長立替経費 235,000円が未精算のまま2ヶ月経過しています。",
      suggested_action: "精算書の提出を顧問先に依頼してください。",
      source: "補助元帳分析",
      amount: 235000,
      done: false
    },
    {
      id: "chk4",
      severity: "mid",
      category: "異常値",
      title: "水道光熱費が前月比+14%",
      description: "水道光熱費が前月比で 60,000円 増加しています。季節要因の可能性もありますが確認を推奨します。",
      suggested_action: "店舗別の内訳確認を推奨します。",
      source: "推移表異常値検知",
      amount: 60000,
      done: false
    },
    {
      id: "chk5",
      severity: "mid",
      category: "原価率",
      title: "売上原価率が前月より悪化",
      description: "売上原価率 37.3% (前月 37.5%) ですが、食材ロスの可能性があるため店舗別で確認を推奨します。",
      suggested_action: "店舗別の食材仕入れ状況をご確認ください。",
      source: "原価分析",
      amount: 0,
      done: false
    }
  ],
  c003: [
    {
      id: "chk1",
      severity: "low",
      category: "締め項目",
      title: "月次締め完了",
      description: "全項目チェック済み。重大な問題は検知されませんでした。",
      suggested_action: "社長レポート生成をお進めください。",
      source: "総合チェック",
      amount: 0,
      done: true
    },
    {
      id: "chk2",
      severity: "low",
      category: "参考",
      title: "前受収益の月次振替確認済み",
      description: "SaaS売上の前受収益 8,400,000円 から当月分 1,200,000円 を売上計上済み。",
      suggested_action: "特にアクションは不要です。",
      source: "前受収益残高",
      amount: 1200000,
      done: true
    }
  ]
};

// 仕訳候補データ
const JOURNAL_CANDIDATES = {
  c001: [
    {
      id: "j001",
      source_type: "請求書",
      source_name: "山田電機_請求書_202603.pdf",
      date: "2026-03-15",
      description: "工具部品仕入（3月分）",
      debit: { account: "仕入高", amount: 248000, tax: "課仕10%" },
      credit: { account: "買掛金", amount: 248000, tax: "" },
      confidence: "high",
      reason: "過去12件の類似仕訳あり。仕入先マスタで勘定科目マッピング済み。"
    },
    {
      id: "j002",
      source_type: "領収書",
      source_name: "IMG_3456.jpg",
      date: "2026-03-18",
      description: "タクシー代（営業部 田中）",
      debit: { account: "旅費交通費", amount: 3200, tax: "課仕10%" },
      credit: { account: "現金", amount: 3200, tax: "" },
      confidence: "high",
      reason: "領収書OCR結果：タクシー会社名・金額を認識。類似仕訳多数。"
    },
    {
      id: "j003",
      source_type: "銀行明細",
      source_name: "みずほ銀行_普通_202603",
      date: "2026-03-20",
      description: "不明な入金 ABCコンサル",
      debit: { account: "普通預金", amount: 550000, tax: "" },
      credit: { account: "（要確認）", amount: 550000, tax: "" },
      confidence: "low",
      reason: "過去の取引履歴にない相手先。顧問先への確認が必要です。"
    },
    {
      id: "j004",
      source_type: "カード明細",
      source_name: "楽天カード_202603",
      date: "2026-03-22",
      description: "Amazon Web Services",
      debit: { account: "通信費", amount: 42800, tax: "課仕10%" },
      credit: { account: "未払金", amount: 42800, tax: "" },
      confidence: "high",
      reason: "AWS定期課金。過去24件の類似仕訳あり。"
    },
    {
      id: "j005",
      source_type: "請求書",
      source_name: "広告代理店_請求書.pdf",
      date: "2026-03-25",
      description: "Web広告運用費（3月分）",
      debit: { account: "広告宣伝費", amount: 340000, tax: "課仕10%" },
      credit: { account: "未払金", amount: 340000, tax: "" },
      confidence: "mid",
      reason: "類似仕訳は3件のみ。金額が通常よりも大きいため承認推奨。"
    },
    {
      id: "j006",
      source_type: "領収書",
      source_name: "IMG_3489.jpg",
      date: "2026-03-26",
      description: "会食費（取引先接待）",
      debit: { account: "交際費", amount: 28600, tax: "課仕10%" },
      credit: { account: "現金", amount: 28600, tax: "" },
      confidence: "mid",
      reason: "OCR結果と通常仕訳パターンより推定。参加者情報が未記入のため確認推奨。"
    }
  ]
};

// 社長向けレポート（機能②で生成済みのサンプル）
const REPORTS = {
  c001: {
    client_id: "c001",
    period: "2026年3月",
    generated_at: "2026-04-12 15:30",
    headline: "売上は好調に回復、利益も前月比+23%。ただし広告費の急増には要注意。",
    sections: {
      highlight: "3月の売上は3,850万円で、前月比+17.4%と大きく回復しました。営業利益は245万円（前月+23.7%）で、年度末として良い形で締めくくれています。一方、広告宣伝費が前月比で3倍近くに増えており、この支出が継続するかどうかで来期の利益水準が変わります。",
      revenue: "売上は前月2月の3,280万円から一気に3,850万円へ。前年同月（3,520万円）比でも+9.4%と堅調です。主要取引先からの受注が増えたことが要因と見られます。売上原価率は70.9%で前月（71.0%）とほぼ同水準。売上増加にきちんと利益がついてきている健全な状態です。",
      costs: "固定費は875万円で前月比ほぼ横ばい。ただし広告宣伝費が52万円（前月18万円）と大きく増加しています。新規施策の開始であれば問題ありませんが、一時的な重複計上の可能性も含めて税理士で内容を確認中です。また、仮払金18万円（昨年11月計上分）が長期未精算のため、4月中の処理を推奨します。",
      cash: "現預金残高は5,230万円で、月商の約1.4ヶ月分を確保できており、資金繰りに懸念はありません。ただし売掛金の長期滞留分（△△商事様 68万円）があるため、回収状況のご確認をお願いします。",
      action: [
        "広告宣伝費の増加要因を確認し、継続施策か一時的な支出かを整理する",
        "仮払金（出張費）の精算を4月中に完了させる",
        "△△商事様への売掛金68万円の回収状況を先方に確認する"
      ],
      next_month_note: "4月は新年度のスタート月。新規商談の受注状況と、広告宣伝費の継続有無がポイントになります。次回面談時に、広告投資に対する手応え（問い合わせ数・成約率など）を共有いただけると議論が深まります。"
    },
    tax_comment: "3月は締め作業にご協力ありがとうございました。広告費の増加について、もし新しい施策の開始であればその意図を共有いただけると、効果測定までサポートできます。"
  },
  c002: {
    client_id: "c002",
    period: "2026年3月",
    generated_at: "2026-04-14 10:15",
    headline: "当月は営業損失△42万円。売上減と人件費増が重なっており、早めの対応が必要です。",
    sections: {
      highlight: "3月は売上1,420万円（前月比△15.5%）、営業損失△42万円となりました。2月までは利益が出ていましたが、3月に入って売上が急減し、一方で人件費や家賃などの固定費は変わらないため赤字に転じた形です。単月の一時的な落ち込みか、継続的な傾向かを見極める必要があります。",
      revenue: "売上は前月1,680万円から1,420万円へ。前年同月（1,550万円）比でも△8.4%と低下しています。店舗別の売上動向を確認し、どの店舗で売上が落ちたのか、客単価・客数のどちらが要因かを整理することをおすすめします。",
      costs: "固定費は932万円。人件費が520万円と前月比+40万円増えています（新規採用の影響と見られます）。家賃220万円、水道光熱費48万円で、水光熱費は前月比+14%増のため店舗別の使用状況をご確認ください。広告宣伝費も38万円と前月比+16万円増加しています。",
      cash: "現預金残高は870万円で、月商の約0.6ヶ月分です。固定費の支払い能力を考慮すると、やや薄い水準です。借入枠の確認や、固定費の見直しが早めに必要になる可能性があります。",
      action: [
        "店舗別の売上内訳を確認し、特に不調な店舗の原因を特定する",
        "3月入社スタッフの配置と売上貢献度を再確認する",
        "直近3ヶ月の資金繰り予定表を作成し、キャッシュの見通しを把握する"
      ],
      next_month_note: "4月の売上動向次第で、固定費の見直しや資金調達の検討が必要になるかもしれません。次回面談では、店舗別PL・採用計画・資金繰り表をもとに、今後の打ち手を一緒に整理できればと思います。"
    },
    tax_comment: "今月は厳しい結果でしたが、早めに状況が見えているのは良いことです。4月第2週に面談をセットさせてください。"
  },
  c003: {
    client_id: "c003",
    period: "2026年3月",
    generated_at: "2026-04-10 11:45",
    headline: "売上・利益とも過去最高を更新。成長トレンドが続いており、組織拡大のタイミングを検討する余地があります。",
    sections: {
      highlight: "3月の売上は2,480万円で過去最高を更新（前月比+6.9%、前年同月比+27.2%）。営業利益も485万円と好調で、営業利益率は19.6%と高水準を維持しています。SaaSビジネスとして健全な成長曲線を描けています。",
      revenue: "売上は直近6ヶ月で一貫して右肩上がり。前年同月比+27.2%は事業としての勢いを示しています。売上原価率は26.6%で前月（26.7%）とほぼ同水準。粗利率は73%台で安定しており、スケーラビリティの高いビジネスモデルが機能しています。",
      costs: "固定費は1,335万円。人件費880万円は前年同月比+29.4%で、事業成長に合わせた増員が行われています。支払手数料125万円（前年同月比+36%）も売上連動で増加しており、これ自体は成長の証です。過度なコスト構造の変化はなく、健全に推移しています。",
      cash: "現預金残高6,820万円は月商の約2.7ヶ月分で、資金余力は十分です。この資金余力を活かした投資（人材採用、マーケティング強化、M&Aなど）の検討余地があります。",
      action: [
        "今期の採用計画の前倒しを検討する（現状の成長速度に組織が追いついているか）",
        "顧客単価向上のためのアップセル施策を強化する",
        "資金余力を活かした成長投資の優先順位を経営会議で整理する"
      ],
      next_month_note: "4月以降も成長継続の可能性が高い状況です。次回面談では、中期的な人員計画と資金配分について議論したいと思います。また、節税面でも投資余地がありますので、合わせてご提案できればと考えています。"
    },
    tax_comment: "好調な月となりました。引き続き、成長投資と節税のバランスについてサポートさせてください。"
  }
};

// ユーティリティ
function fmtYen(n) {
  if (n === 0) return "0";
  const sign = n < 0 ? "△" : "";
  const abs = Math.abs(n);
  return sign + abs.toLocaleString("ja-JP") + "円";
}

function fmtYenShort(n) {
  const sign = n < 0 ? "△" : "";
  const abs = Math.abs(n);
  if (abs >= 100000000) return sign + (abs/100000000).toFixed(1) + "億円";
  if (abs >= 10000) return sign + (abs/10000).toFixed(0) + "万円";
  return sign + abs.toLocaleString("ja-JP") + "円";
}

function fmtPct(cur, prev) {
  if (prev === 0) return "-";
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  const sign = pct > 0 ? "+" : "";
  return sign + pct.toFixed(1) + "%";
}

function getCurrentClient() {
  const id = localStorage.getItem("kp_current_client") || "c001";
  return CLIENTS.find(c => c.id === id) || CLIENTS[0];
}

function setCurrentClient(id) {
  localStorage.setItem("kp_current_client", id);
}
