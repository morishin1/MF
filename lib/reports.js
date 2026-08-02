// reports.js — 当アプリ内の承認済み仕訳から月次試算表を集計する。
// MFを使わない取引先でも、アップロード→AI仕訳→承認で溜まった仕訳から試算表を作れる。
// 注意: これは「当アプリで捕捉した仕訳のみ」の集計。期首残高や他システムの取引は含まない。

export function periodRange(period) {
  // period 'YYYY-MM' → { start:'YYYY-MM-01', end:'翌月-01' }
  const [y, m] = String(period).split("-").map(Number);
  const start = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const end = `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-01`;
  return { start, end };
}

// 対象月の仕訳をCSV文字列にする（Excelで開けるよう BOM 付き）
export async function journalsCsv(sb, clientId, period) {
  const { start, end } = periodRange(period);
  const { data, error } = await sb
    .from("journals")
    .select("id, txn_date, partner_name, description, lines, tax_category, confidence, status, total_amount")
    .eq("client_id", clientId)
    .gte("txn_date", start)
    .lt("txn_date", end)
    .order("txn_date", { ascending: true });
  if (error) throw new Error("journals_query: " + error.message);

  const STATUS = { draft: "確認待ち", approved: "承認済み", sent: "MF登録済み", rejected: "却下", error: "エラー" };
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [
    ["仕訳ID", "日付", "取引先", "摘要", "貸借", "勘定科目", "補助科目", "金額", "税区分", "確度", "状態"].join(","),
  ];
  for (const j of data || []) {
    const lines = (j.lines || []).length ? j.lines : [{}];
    for (const l of lines) {
      rows.push([
        q(j.id), q(j.txn_date), q(j.partner_name), q(j.description),
        q(l.side === "debit" ? "借方" : l.side === "credit" ? "貸方" : ""),
        q(l.account), q(l.sub_account), q(l.amount ?? j.total_amount),
        q(l.tax || j.tax_category), q(j.confidence), q(STATUS[j.status] || j.status),
      ].join(","));
    }
  }
  return "﻿" + rows.join("\r\n") + "\r\n";
}

// 承認済み(approved)・登録済み(sent)の仕訳を対象月で集計する
export async function computeTrialBalance(sb, clientId, period) {
  const { start, end } = periodRange(period);
  const { data, error } = await sb
    .from("journals")
    .select("lines, txn_date, status")
    .eq("client_id", clientId)
    .in("status", ["approved", "sent"])
    .gte("txn_date", start)
    .lt("txn_date", end);
  if (error) throw new Error("journals_query: " + error.message);

  const map = new Map();
  let journalCount = 0;
  for (const j of data || []) {
    journalCount++;
    for (const l of j.lines || []) {
      const acc = l.account || "(不明)";
      const cur = map.get(acc) || { account: acc, debit: 0, credit: 0 };
      const amt = Number(l.amount) || 0;
      if (l.side === "debit") cur.debit += amt;
      else if (l.side === "credit") cur.credit += amt;
      map.set(acc, cur);
    }
  }

  const accounts = [...map.values()]
    .map((a) => ({ ...a, balance: a.debit - a.credit }))
    .sort((x, y) => x.account.localeCompare(y.account, "ja"));
  const totals = accounts.reduce(
    (t, a) => ({ debit: t.debit + a.debit, credit: t.credit + a.credit }),
    { debit: 0, credit: 0 }
  );
  return { period, journalCount, accounts, totals };
}
