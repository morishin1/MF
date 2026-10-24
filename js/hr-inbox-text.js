// 採用メール新着受付：本文の安全な表示と、応募者情報の「候補」を取り出す道具（画面とテストで共通）。
//
// ■ 守ること
//   - 本文はすべてエスケープしてから表示する。リンクにするのは http:// と https:// だけ。
//     javascript: や data: は文字のまま出す（押しても何も起きない）。
//   - 取り出した氏名・メール・電話は「候補」。確定ではない。取れなければ「未取得」とし、人が直せるようにする。
//   - 求人媒体の通知専用アドレス（no-reply 等）を、応募者本人のアドレスとして扱わない。
//   - サーバ（api/hr/inbox-ingest.js）は推定しない。推定は担当者が見る画面の上だけ。
(function (root) {
  "use strict";

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---- 本文の URL をリンクにする ---------------------------------------------------
  // 全角の記号・空白・括弧で URL を終える（日本語の文章に続けて書かれた URL のため）
  const URL_RE = /https?:\/\/[^\s<>"'`　-〿！-／：-＠［-｀｛-･]+/gi;
  const TRAIL = /[.,;:!?'"*_~]+$/;

  /** 末尾の句読点や閉じ括弧（対応する開き括弧が無いもの）を URL から外す */
  function trimUrl(raw) {
    let url = raw;
    for (let i = 0; i < 5; i++) {
      const before = url;
      url = url.replace(TRAIL, "");
      for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
        if (url.endsWith(close) && url.split(open).length < url.split(close).length) url = url.slice(0, -1);
      }
      if (url === before) break;
    }
    return url;
  }

  /** http(s) の URL だけを、その場で安全に確かめる（URL として読めて、ホストがあること） */
  function safeHref(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      if (!u.hostname || u.username || u.password) return null;
      return u.href;
    } catch { return null; }
  }

  /**
   * 本文を HTML にする。URL 以外はすべてエスケープ。リンクは新しいタブで開き、参照元を渡さない。
   * @returns {{html:string, links:number}}
   */
  function linkify(text, { max = 50 } = {}) {
    const src = String(text ?? "");
    let out = "", last = 0, links = 0;
    URL_RE.lastIndex = 0;
    for (let m; (m = URL_RE.exec(src));) {
      const url = trimUrl(m[0]);
      const href = links < max ? safeHref(url) : null;
      out += esc(src.slice(last, m.index));
      if (href) {
        out += `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer nofollow" class="in-link">${esc(url)}</a>`;
        links++;
      } else out += esc(url);
      last = m.index + url.length;
      URL_RE.lastIndex = last;
    }
    out += esc(src.slice(last));
    return { html: out, links };
  }

  // ---- 差出人の見分け ---------------------------------------------------------------
  // 求人媒体のドメイン → 応募媒体の固定候補（lib/hr.js APPLICANT_SOURCES）と同じ表記
  const MEDIA = [
    { re: /(^|\.)wantedly\.com$/i, label: "Wantedly" },
    { re: /(^|\.)green-japan\.com$/i, label: "Green" },
    { re: /(^|\.)indeed(email)?\.(com|jp)$/i, label: "Indeed" },
    { re: /(^|\.)kyujinbox\.com$/i, label: "求人ボックス" },
  ];
  // 通知専用・システム送信と分かる差出人（本人ではない）
  const NOTIFY_LOCAL = /^(no-?reply|do-?not-?reply|noreply|notifications?|notify|notice|mailer(-daemon)?|system|alerts?|bounce[s]?|postmaster)([+._-]|$)/i;
  // 社内（転送・手入力）。応募者本人のアドレスとして出さない
  const INTERNAL = /(^|\.)8grp\.co\.jp$/i;
  const FREE_MAIL = /(^|\.)(gmail\.com|googlemail\.com|yahoo\.co\.jp|ymail\.ne\.jp|icloud\.com|me\.com|outlook\.(com|jp)|hotmail\.(com|co\.jp)|live\.jp|docomo\.ne\.jp|ezweb\.ne\.jp|au\.com|softbank\.ne\.jp|i\.softbank\.jp|nifty\.com|biglobe\.ne\.jp|ocn\.ne\.jp|so-net\.ne\.jp)$/i;
  const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
  const isEmail = (s) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(s || ""));

  /**
   * 差出人アドレスの種類。
   *   notification … 求人媒体・通知専用（本人ではない）
   *   internal     … 社内（転送など）
   *   person       … 個人のメール（フリーメール等。本人の可能性が高い。ただし確定ではない）
   *   unknown      … 判断できない
   */
  function classifyAddress(address) {
    const a = String(address || "").trim().toLowerCase();
    if (!isEmail(a)) return { kind: "none", media: null };
    const [local, domain] = [a.slice(0, a.lastIndexOf("@")), a.slice(a.lastIndexOf("@") + 1)];
    const media = MEDIA.find((m) => m.re.test(domain))?.label || null;
    if (INTERNAL.test(domain)) return { kind: "internal", media: null };
    if (media || NOTIFY_LOCAL.test(local)) return { kind: "notification", media };
    if (FREE_MAIL.test(domain)) return { kind: "person", media: null };
    return { kind: "unknown", media: null };
  }

  // ---- 応募者情報の候補 --------------------------------------------------------------
  const LABEL_SEP = "\\s*[：:]\\s*";
  const firstLine = (s) => String(s || "").split(/\r?\n/)[0].trim();
  const cleanName = (s) => firstLine(s).replace(/\s*(様|さま|さん|殿)\s*$/, "").replace(/^[「『【\[]|[」』】\]]$/g, "").trim();
  const plausibleName = (s) => s.length >= 2 && s.length <= 30 && !/[@\/:<>{}=]|https?/i.test(s) && !/^\d+$/.test(s);

  function labeled(text, labels, max = 120) {
    const re = new RegExp("(?:^|\\n)\\s*[・■●◆\\-]?\\s*(?:" + labels.join("|") + ")" + LABEL_SEP + "([^\\n\\r]{1," + max + "})", "i");
    const m = String(text || "").match(re);
    return m ? m[1].trim() : "";
  }

  function nameFrom(mail) {
    const body = String(mail.body_text || "");
    const v = cleanName(labeled(body, ["氏名", "お名前", "名前", "応募者名?", "応募者氏名", "候補者名?", "Name"], 40));
    if (v && plausibleName(v)) return { value: v, from: "本文" };
    const subject = String(mail.subject || "").replace(/^\s*(?:【[^】]*】|\[[^\]]*\])\s*/g, "");
    const m = subject.match(/^(.{2,20}?)\s*(?:さん|様)(?:から|より|が)/);
    if (m && plausibleName(m[1].trim())) return { value: m[1].trim(), from: "件名" };
    const saved = String(mail.candidate_name_guess || "").trim();
    if (saved) return { value: saved, from: "登録時の入力" };
    return { value: "", from: null };
  }

  function emailFrom(mail) {
    const sender = String(mail.sender_address || "").toLowerCase();
    const reply = String(mail.reply_to || "").toLowerCase();
    const r = classifyAddress(reply);
    if (reply && reply !== sender && (r.kind === "person" || r.kind === "unknown")) return { value: reply, from: "返信先" };
    const body = String(mail.body_text || "");
    const lab = labeled(body, ["メールアドレス", "メール", "E-?mail", "連絡先メール"], 120).match(EMAIL_RE)?.[0];
    if (lab && ["person", "unknown"].includes(classifyAddress(lab).kind)) return { value: lab.toLowerCase(), from: "本文" };
    const s = classifyAddress(sender);
    if (s.kind === "person") return { value: sender, from: "差出人" };
    if (reply && r.kind === "person") return { value: reply, from: "返信先" };
    return { value: "", from: null };
  }

  function phoneFrom(mail) {
    const v = labeled(String(mail.body_text || ""), ["電話番号", "電話", "TEL", "携帯(?:電話)?(?:番号)?", "連絡先電話"], 40);
    const raw = v.normalize ? v.normalize("NFKC") : v;
    const m = raw.match(/\+?\d[\d\-() ]{8,18}\d/);
    if (!m) return { value: "", from: null };
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 13) return { value: "", from: null };
    return { value: m[0].replace(/\s+/g, ""), from: "本文" };
  }

  function jobFrom(mail) {
    const v = firstLine(labeled(String(mail.body_text || ""), ["応募職種", "募集職種", "職種", "応募求人", "求人(?:タイトル|名)?", "募集(?:タイトル|名)"], 100));
    if (v) return { value: v.slice(0, 100), from: "本文" };
    const m = String(mail.subject || "").match(/「([^」]{2,60})」(?:に|へ)/);
    if (m) return { value: m[1], from: "件名" };
    const saved = String(mail.job_title_guess || "").trim();
    if (saved) return { value: saved, from: "登録時の入力" };
    return { value: "", from: null };
  }

  function sourceFrom(mail) {
    const s = classifyAddress(mail.sender_address).media || classifyAddress(mail.reply_to).media;
    if (s) return { value: s, from: "差出人" };
    const text = String(mail.subject || "") + "\n" + String(mail.body_text || "").slice(0, 2000);
    if (/wantedly/i.test(text)) return { value: "Wantedly", from: "本文" };
    if (/indeed/i.test(text)) return { value: "Indeed", from: "本文" };
    if (/求人ボックス/.test(text)) return { value: "求人ボックス", from: "本文" };
    const saved = String(mail.source_guess || "").trim();
    if (saved) return { value: saved, from: "登録時の入力" };
    return { value: "", from: null };
  }

  /** 1通のメールから、応募者情報の候補をまとめて出す（どれも確定ではない） */
  function extract(mail) {
    const m = mail || {};
    return {
      name: nameFrom(m), email: emailFrom(m), phone: phoneFrom(m), jobTitle: jobFrom(m), source: sourceFrom(m),
      sender: { address: String(m.sender_address || ""), ...classifyAddress(m.sender_address) },
      replyTo: { address: String(m.reply_to || ""), ...classifyAddress(m.reply_to) },
    };
  }

  // ---- 重複の候補 -------------------------------------------------------------------
  const normName = (s) => String(s || "").normalize("NFKC").replace(/[\s　・･.]/g, "").toLowerCase();
  const normEmail = (s) => String(s || "").trim().toLowerCase();

  /**
   * 既に登録済みの応募者から、同じ人の可能性がある人を出す。決めるのは人。
   * @param {{name?:string, email?:string}} draft
   * @param {{id:string, name?:string, email?:string}[]} applicants
   */
  function duplicates(draft, applicants) {
    const n = normName(draft?.name), e = normEmail(draft?.email);
    const out = [];
    for (const a of applicants || []) {
      const reasons = [];
      if (e && normEmail(a.email) === e) reasons.push("メールが同じ");
      const an = normName(a.name);
      if (n && an && an === n) reasons.push("氏名が同じ");
      else if (n && an && n.length >= 3 && an.length >= 3 && (an.includes(n) || n.includes(an))) reasons.push("氏名が似ている");
      if (reasons.length) out.push({ applicant: a, reasons, strong: reasons.includes("メールが同じ") || reasons.includes("氏名が同じ") });
    }
    return out.sort((x, y) => Number(y.strong) - Number(x.strong));
  }

  // ---- 状態と操作の説明（画面に出す文） ------------------------------------------------
  const STATES = {
    new: { label: "新着", open: true, help: "まだ誰も対応していないメールです。" },
    review: { label: "確認中", open: true, help: "担当者が確認しています。登録または対応終了するまで「未対応」に数えます。" },
    linked: { label: "登録済み", open: false, help: "応募者に紐づけ済みです。経緯は応募者の詳細で確認できます。" },
    ignored: { label: "対応終了", open: false, help: "応募者として登録しないと判断しました。理由はメモに残ります。必要なら未対応に戻せます。" },
  };
  const ACTIONS = [
    { key: "register", label: "応募者として登録", help: "確認した内容で応募者を新しく登録し、このメールを紐づけます。登録できたときだけ「登録済み」になります。" },
    { key: "link", label: "既存の応募者に紐づける", help: "同じ人がすでに登録されているときに使います。" },
    { key: "review", label: "確認中にする", help: "対応中であることを他の担当者に知らせます。未対応のままです。" },
    { key: "ignored", label: "対応終了（登録しない）", help: "営業メール・重複・スポット人材として別に管理する等、登録しない理由を残して閉じます。" },
    { key: "new", label: "未対応に戻す", help: "確認中・対応終了にしたメールを、新着に戻します。" },
  ];
  // 登録先。採用の一覧の区分（lib/hr.js LIST_TABS）とスポット人材（別管理）に合わせる
  const DESTINATIONS = [
    { key: "active", label: "選考中（通常の採用）", register: true },
    { key: "contractor", label: "業務委託", register: true, employmentType: "業務委託" },
    { key: "mugendojo", label: "無限道場", register: false,
      help: "無限道場への新規登録はこの画面からはできません（LPからの登録のみ）。登録済みのリードがあれば「既存の応募者に紐づける」を使ってください。" },
    { key: "spot", label: "スポット人材", register: false,
      help: "スポット人材は別の画面（スポット人材）で管理します。そちらで登録してから、このメールは「対応終了」にして理由を残してください。" },
    { key: "closed", label: "終了（登録しない）", register: false,
      help: "応募者として登録しない場合は「対応終了（登録しない）」で理由を残してください。" },
  ];

  root.HrInboxText = { esc, linkify, safeHref, trimUrl, classifyAddress, extract, duplicates, normName, normEmail, STATES, ACTIONS, DESTINATIONS };
})(typeof window !== "undefined" ? window : globalThis);
