// メンバー管理（admin-members.html）の、画面に依存しない部分。
//   ・一括登録：表計算の貼り付け（タブ区切り）と CSV の読み取り、登録前のプレビュー（行ごとの判定）
//   ・一覧：検索・絞り込み・ページ分け
//   ・一括登録の結果の仕分け（追加／重複で飛ばした／失敗／名簿は入ったがアカウントは作れなかった）
//
// ブラウザでは window.MemberBulk、テスト（node）では module.exports から使う。
// 判定はここ1か所。画面に同じ条件を書かない（test/memberbulk.mjs が、ここを直接呼んで確かめる）。
(function (root) {
  "use strict";

  // サーバ（api/employees/bulk.js・index.js）と同じ並び
  const EMPLOYMENT_TYPES = ["正社員", "契約社員", "パート", "アルバイト", "業務委託", "役員", "その他"];
  const MAX_ROWS = 200;
  const COLS = ["display_name", "email", "department", "position", "employment_type", "joined_on"];
  const COL_LABEL = { display_name: "氏名", email: "メール", department: "部署", position: "役職", employment_type: "雇用区分", joined_on: "入社日" };
  // 見出し行の言い方（ゆれ）。1行目がこれらなら、列の順番ではなく見出しで読む
  const HEADER_ALIASES = {
    display_name: ["氏名", "名前", "氏名（必須）", "氏名(必須)", "name"],
    email: ["メール", "メールアドレス", "email", "e-mail", "mail"],
    department: ["部署", "所属", "department"],
    position: ["役職", "position"],
    employment_type: ["雇用区分", "雇用形態", "employment_type"],
    joined_on: ["入社日", "入社予定日", "joined_on"],
  };
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /**
   * CSV（RFC 4180）とタブ区切りを読む。
   *   ・先頭の BOM を外す。改行は CRLF・LF・CR のどれでもよい
   *   ・"…" で囲んだ欄の中の区切り文字・改行はそのまま。"" は " 1つ
   *   ・区切りは、1行目（引用符の外）にタブがあればタブ、無ければカンマ
   * 返り値 { rows: [{ line, cells }], delimiter, error }。line は、その行が始まる元の行番号（1から）
   */
  function parseDelimited(text) {
    let s = String(text ?? "");
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    const delimiter = detectDelimiter(s);
    const rows = [];
    let cells = [];
    let cell = "";
    let quoted = false;     // いま "…" の中か
    let wasQuoted = false;  // この欄が "…" で始まったか（閉じたあとの文字を見分ける）
    let line = 1;
    let rowLine = 1;
    const pushCell = () => { cells.push(wasQuoted ? cell : cell.trim()); cell = ""; wasQuoted = false; };
    const pushRow = () => {
      pushCell();
      // 空の行（区切りしか無い行も）は捨てる
      if (cells.some((c) => c !== "")) rows.push({ line: rowLine, cells });
      cells = [];
    };
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quoted) {
        if (ch === '"') {
          if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
        } else {
          if (ch === "\r" && s[i + 1] === "\n") { cell += "\n"; i++; line++; }
          else if (ch === "\n" || ch === "\r") { cell += "\n"; line++; }
          else cell += ch;
        }
        continue;
      }
      if (ch === '"' && cell.trim() === "" && !wasQuoted) { quoted = true; wasQuoted = true; cell = ""; continue; }
      if (ch === delimiter) { pushCell(); continue; }
      if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && s[i + 1] === "\n") i++;
        pushRow();
        line++;
        rowLine = line;
        continue;
      }
      if (wasQuoted) {
        // "abc"x のように、閉じた引用符のあとに文字が続く。黙って読むと列がずれるので、読めない行として返す
        if (ch === " " || ch === "\t") continue;
        return { rows, delimiter, error: { code: "bad_quote", line: rowLine, message: `${rowLine}行目：引用符（"）の閉じ方が正しくありません` } };
      }
      cell += ch;
    }
    if (quoted) {
      return { rows, delimiter, error: { code: "unclosed_quote", line: rowLine, message: `${rowLine}行目：引用符（"）が閉じられていません` } };
    }
    if (cell !== "" || cells.length || wasQuoted) pushRow();
    return { rows, delimiter, error: null };
  }

  // 1行目（引用符の外）にタブがあればタブ区切り（表計算からの貼り付け）。無ければカンマ
  function detectDelimiter(s) {
    let quoted = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') { quoted = !quoted; continue; }
      if (quoted) continue;
      if (ch === "\t") return "\t";
      if (ch === "\n" || ch === "\r") break;
    }
    return ",";
  }

  const norm = (v) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, "");
  function headerMap(cells) {
    const map = {};
    let hits = 0;
    cells.forEach((c, i) => {
      const n = norm(c);
      for (const [key, names] of Object.entries(HEADER_ALIASES)) {
        if (names.some((x) => norm(x) === n) && map[key] === undefined) { map[key] = i; hits++; }
      }
    });
    // 氏名の列が見出しで分かったときだけ、見出しとして扱う（データの1行目を見出しと取り違えない）
    return hits && map.display_name !== undefined ? map : null;
  }

  /**
   * 読み取った行を、1人ずつの記録にする。1行目が見出しなら、見出しで列を決める。
   * 返り値 { records: [{ line, value }], header: bool, unknownColumns: [] }
   */
  function toRecords(rows) {
    if (!rows.length) return { records: [], header: false, unknownColumns: [] };
    const hm = headerMap(rows[0].cells);
    const body = hm ? rows.slice(1) : rows;
    const unknownColumns = hm
      ? rows[0].cells.filter((c, i) => c && !Object.values(hm).includes(i))
      : [];
    const records = body.map((r) => {
      const value = {};
      COLS.forEach((k, i) => {
        const idx = hm ? hm[k] : i;
        value[k] = idx === undefined ? "" : String(r.cells[idx] ?? "").trim();
      });
      return { line: r.line, value, extra: hm ? [] : r.cells.slice(COLS.length).filter((c) => c !== "") };
    });
    return { records, header: Boolean(hm), unknownColumns };
  }

  /** 入社日：2026-04-01 / 2026/4/1 / 2026.4.1 を 2026-04-01 にする。読めなければ null */
  function normalizeDate(s) {
    const t = String(s ?? "").trim();
    if (!t) return "";
    const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  /**
   * 登録前のプレビュー。行ごとに判定する（登録はしない）。
   *   status: "ok"        … 登録できる
   *           "error"     … 入力に誤りがある（登録しない）
   *           "registered"… 同じ氏名・メールの人が名簿にいる（登録しない。上書きもしない）
   *           "duplicate" … このファイルの中で、前の行と同じ氏名・メール（登録しない）
   * existing は、いまの名簿（display_name・email）。サーバ（api/employees/bulk.js）と同じ見分け方：氏名は完全一致、メールは小文字で一致
   */
  function preview(records, existing = []) {
    const names = new Map();
    const mails = new Map();
    for (const e of existing) {
      if (e.display_name) names.set(e.display_name.trim(), e);
      if (e.email) mails.set(String(e.email).trim().toLowerCase(), e);
    }
    const seenName = new Map();
    const seenMail = new Map();
    const items = records.map((r) => {
      const v = { ...r.value };
      const reasons = [];
      v.display_name = v.display_name.trim();
      v.email = v.email.trim().toLowerCase();
      if (!v.display_name) reasons.push("氏名が空です");
      if (v.display_name.length > 100) reasons.push("氏名が長すぎます（100文字まで）");
      if (v.email && !EMAIL_RE.test(v.email)) reasons.push(`メールアドレスの形が正しくありません（${v.email}）`);
      if (v.employment_type && !EMPLOYMENT_TYPES.includes(v.employment_type)) {
        reasons.push(`雇用区分「${v.employment_type}」は使えません（${EMPLOYMENT_TYPES.join("・")}）`);
      }
      const d = normalizeDate(v.joined_on);
      if (d === null) reasons.push(`入社日「${v.joined_on}」を読めません（2026-04-01 の形で、実在する日付）`);
      else v.joined_on = d;
      if (r.extra && r.extra.length) reasons.push(`列が多すぎます（7列目以降：${r.extra.join(" / ")}）。順番は 氏名 / メール / 部署 / 役職 / 雇用区分 / 入社日`);
      if (/\n/.test(Object.values(v).join(""))) reasons.push("欄の中に改行があります");

      let status = reasons.length ? "error" : "ok";
      if (status === "ok") {
        const byName = names.get(v.display_name);
        const byMail = v.email ? mails.get(v.email) : null;
        if (byName || byMail) {
          status = "registered";
          reasons.push(byName ? "同じ氏名の人が名簿にいます（追加しません）" : `同じメールの人（${byMail.display_name}）が名簿にいます（追加しません）`);
        }
      }
      if (status === "ok") {
        const dn = seenName.get(v.display_name);
        const dm = v.email ? seenMail.get(v.email) : undefined;
        if (dn !== undefined || dm !== undefined) {
          status = "duplicate";
          reasons.push(dn !== undefined ? `${dn}行目と同じ氏名です（追加しません）` : `${dm}行目と同じメールです（追加しません）`);
        }
      }
      if (status === "ok") {
        seenName.set(v.display_name, r.line);
        if (v.email) seenMail.set(v.email, r.line);
      }
      return { line: r.line, value: v, status, reasons };
    });
    const count = (s) => items.filter((x) => x.status === s).length;
    const tooMany = items.filter((x) => x.status === "ok").length > MAX_ROWS;
    return {
      items,
      summary: { total: items.length, ok: count("ok"), error: count("error"), registered: count("registered"), duplicate: count("duplicate") },
      tooMany,
    };
  }

  /** テキスト（貼り付け・ファイル）→ プレビュー。読めない形なら error を返す（プレビューは出さない） */
  function previewText(text, existing) {
    const parsed = parseDelimited(text);
    if (parsed.error) return { error: parsed.error.message, items: [], summary: null };
    const { records, header, unknownColumns } = toRecords(parsed.rows);
    if (!records.length) return { error: "読み取れる行がありません。", items: [], summary: null };
    const p = preview(records, existing);
    return { ...p, header, unknownColumns, delimiter: parsed.delimiter === "\t" ? "タブ区切り" : "カンマ区切り（CSV）", error: null };
  }

  /** 名簿へ送る行（登録できる行だけ）と、送った順番 → 元の行番号の対応 */
  function rowsToSend(items) {
    const ok = items.filter((x) => x.status === "ok");
    return { rows: ok.map((x) => ({ ...x.value })), lines: ok.map((x) => x.line), items: ok };
  }

  /**
   * サーバの結果（api/employees/bulk.js）を、元の行番号つきで仕分ける。
   * sent = rowsToSend の返り値（サーバの line は、送った順の1から）
   */
  function classifyResult(res, sent) {
    const src = (line) => sent.lines[line - 1] ?? null;
    const item = (line) => sent.items[line - 1] || null;
    const added = (res.added || []).map((a) => ({ ...a, srcLine: src(a.line), value: item(a.line)?.value || null }));
    return {
      added,
      accountCreated: added.filter((a) => a.account === "created"),
      accountLinked: added.filter((a) => a.account === "linked"),
      accountFailed: added.filter((a) => a.account === "failed"),
      accountNoEmail: added.filter((a) => a.account === "no_email"),
      skipped: (res.skipped || []).map((x) => ({ ...x, srcLine: src(x.line), value: item(x.line)?.value || null })),
      failed: (res.failed || []).map((x) => ({ ...x, srcLine: src(x.line), value: item(x.line)?.value || null })),
      withAccounts: Boolean(res.withAccounts),
    };
  }

  /** 失敗した行だけを、見出しつきのタブ区切りに戻す（直して、もう一度プレビューするため） */
  function toTsv(values) {
    const cell = (c) => {
      const t = String(c ?? "");
      return /[\t\n"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    return [COLS.map((k) => COL_LABEL[k]).join("\t"), ...values.map((v) => COLS.map((k) => cell(v[k])).join("\t"))].join("\n");
  }

  // ---- 一覧：検索・絞り込み・ページ分け ---------------------------------------------
  const APP_KEYS = ["hr", "sales", "office", "keiei"];

  /**
   * f = { q, status, type, app, showLeft, onlyIds }
   *   status: "" | invited | active | leaving | left
   *   app: "" | hr | sales | office | keiei | none（4つとも使えない）
   *   showLeft: false なら、退職（left）を出さない（status で left を選んだときは出す）
   *   onlyIds: Set を渡すと、その人だけ（「選択中だけ表示」）
   */
  function filterMembers(list, f = {}) {
    const q = norm(f.q);
    return (list || []).filter((e) => {
      if (f.onlyIds && !f.onlyIds.has(e.id)) return false;
      if (f.status) { if (e.status !== f.status) return false; }
      else if (!f.showLeft && e.status === "left") return false;
      if (f.type && (e.employment_type || "") !== f.type) return false;
      if (f.app) {
        const apps = e.apps || null;
        if (!apps) return false;
        if (f.app === "none") { if (APP_KEYS.some((k) => apps[k])) return false; }
        else if (!apps[f.app]) return false;
      }
      if (q) {
        const hay = norm([e.display_name, e.email, e.department, e.position].filter(Boolean).join(" "));
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function pageOf(list, page, size) {
    const pages = Math.max(1, Math.ceil(list.length / size));
    const p = Math.min(Math.max(1, page || 1), pages);
    return { page: p, pages, rows: list.slice((p - 1) * size, p * size), from: list.length ? (p - 1) * size + 1 : 0, to: Math.min(p * size, list.length) };
  }

  const api = {
    EMPLOYMENT_TYPES, MAX_ROWS, COLS, COL_LABEL,
    parseDelimited, toRecords, normalizeDate, preview, previewText, rowsToSend, classifyResult, toTsv,
    filterMembers, pageOf,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MemberBulk = api;
})(typeof window !== "undefined" ? window : globalThis);
