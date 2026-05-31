// data-loader.js
// 自社1社運用ツール用の実データローダー。
// data/ 配下の JSON を fetch で読み込む。file:// 直開きでは fetch が失敗するため
// 各メソッドは取得不可時に null（または既定の空オブジェクト）を返し、UI 側で空状態表示にフォールバックする。
//
// ローカルサーバ前提:  例)  python -m http.server 8000  → http://localhost:8000/dashboard.html
//
// 期待するファイル構成（スラッシュコマンドが順次生成）:
//   data/company.json                       自社情報
//   data/master/{accounts,sub_accounts,partners,departments}.json
//   data/master/_fetched_at.json
//   data/periods/YYYY-MM/journals_draft.json   { period, generated_at, journals:[{id,date,description,partner,amount,confidence,status,lines}] }
//   data/periods/YYYY-MM/journals_sent.json    { period, journals:[{id,idempotency_key,sent_at,mf_journal_id,amount}] }
//   data/periods/YYYY-MM/trial_balance.json    { period, fetched_at, summary:{revenue,gross_profit,operating_profit,cash,...}, accounts:[...] }
//   data/periods/YYYY-MM/closing_checks.json   { period, checked_at, issues:[{id,severity,title,description}], checklist:[{key,label,done}] }
//   data/periods/YYYY-MM/report.md             月次レポート（テキスト）

const DataLoader = (() => {
  const BASE = "data";

  // 取得不可（404・ネットワーク・file:// 制約）は握りつぶして null を返す
  async function _json(path) {
    try {
      const res = await fetch(`${BASE}/${path}`, { cache: "no-store" });
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  async function _text(path) {
    try {
      const res = await fetch(`${BASE}/${path}`, { cache: "no-store" });
      if (!res.ok) return null;
      return await res.text();
    } catch (_) {
      return null;
    }
  }

  return {
    /** file:// で開かれている＝fetch がほぼ確実に失敗する状況かどうか */
    isFileProtocol() {
      return location.protocol === "file:";
    },

    async company() {
      return await _json("company.json");
    },

    async masters() {
      const [accounts, subAccounts, partners, departments, fetchedAt] = await Promise.all([
        _json("master/accounts.json"),
        _json("master/sub_accounts.json"),
        _json("master/partners.json"),
        _json("master/departments.json"),
        _json("master/_fetched_at.json"),
      ]);
      return { accounts, subAccounts, partners, departments, fetchedAt };
    },

    /** 指定月 (YYYY-MM) の全データをまとめて取得。存在しないファイルは null */
    async period(ym) {
      const dir = `periods/${ym}`;
      const [draft, sent, trial, closing, report] = await Promise.all([
        _json(`${dir}/journals_draft.json`),
        _json(`${dir}/journals_sent.json`),
        _json(`${dir}/trial_balance.json`),
        _json(`${dir}/closing_checks.json`),
        _text(`${dir}/report.md`),
      ]);
      return { ym, draft, sent, trial, closing, report };
    },
  };
})();

// ---- 表示ユーティリティ -------------------------------------------------

/** 円表記。null/undefined は "—" */
function fmtYen(v) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  const sign = v < 0 ? "△" : "";
  return sign + "¥" + Math.abs(Math.round(v)).toLocaleString("ja-JP");
}

/** 千円丸めの短縮表記（KPI用）。負は△ */
function fmtYenShort(v) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  const sign = v < 0 ? "△" : "";
  const a = Math.abs(v);
  if (a >= 100000000) return sign + (a / 100000000).toFixed(1) + "億";
  if (a >= 10000) return sign + Math.round(a / 10000).toLocaleString("ja-JP") + "万";
  return sign + a.toLocaleString("ja-JP");
}

/** YYYY-MM → "2026年4月" */
function fmtPeriodJa(ym) {
  if (!ym) return "";
  const [y, m] = ym.split("-");
  return `${y}年${parseInt(m, 10)}月`;
}

/**
 * ダッシュボードの既定対象月。
 * 経理は前月分を当月処理するため「先月」を既定にする。
 */
function defaultPeriod(today = new Date()) {
  const d = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** 直近 n ヶ月分の YYYY-MM 候補（新しい順）。月セレクタ用 */
function recentPeriods(n = 12, today = new Date()) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    out.push(`${y}-${m}`);
  }
  return out;
}
