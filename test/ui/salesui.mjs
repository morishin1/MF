// 営業アタック管理（/sales）を、実際のブラウザで通す。
//
// ■ 何を守るテストか
//
//   1. 営業担当としてログインすると、専用ヘッダー（EIGHT/SALES・5ナビ）が出る
//   2. ダッシュボードの「今やること」に、未対応クリックが件数つきで出る
//   3. 企業一覧 → 右ドロワー → フォームアタック → 本文に専用URLが入る →
//      「送信完了」で本文つきの記録が送られる
//   4. 直近30日以内にアタック済みなら、警告が出て送れない（営業担当には押し切りボタンを出さない）
//   5. 権限の無い人は home.html へ送り返される
//   6. スマホ幅でも横にはみ出さない
//   7. 送信完了は送信チャネル（必須）・送信元を中央モーダルで選ぶ。「送信できなかった」は理由必須（db/096）
//   8. 非表示：一括で非表示 → 通常の一覧から消える → 「非表示」で見える → 再表示
//   9. 返信・やり取りを記録：返信元・いまの連絡手段・連絡先・メモ・NEXT。企業詳細に「現在の連絡状況」
import { launch, BASE, jstToday } from "../_browser.mjs";
// ダッシュボード（/sales/）の4段は、本物と同じくサーバ側の決まり（lib/sales-dashboard.js）で組み立てる
import { dashboardSections } from "../../lib/sales-dashboard.js";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const SALES = { id: "emp-s1", display_name: "営業 一郎", status: "active" };
const TODAY = jstToday();
const NOW = new Date().toISOString();

function company(over) {
  return {
    id: "c1", name: "株式会社サンプル", domain: "sample.co.jp", siteUrl: "https://sample.co.jp/",
    formUrl: "https://sample.co.jp/contact", industry: "製造", region: "東京都", service: "AI / DX",
    ownerId: "emp-s1", ownerName: "営業 一郎", status: "untouched", statusLabel: "未アタック",
    ngReason: null, ngLabel: null, attackCount: 0, lastSentAt: null, clickCount: 0, firstClickAt: null,
    lastClickAt: null, unhandledClick: false, next: "フォームアタック", nextKey: "attack", nextDue: null,
    overdue: false, campaignId: null, campaignName: null, hidden: false, hiddenLabel: null,
    contactChannel: null, contactChannelLabel: null, contactValue: null, contacts: {}, ...over,
  };
}

// 本物（lib/sales-master.js・lib/sales-csv-import.js）と同じ値。画面はこれを API の応答で受け取る
const MASTERS = {
  industries: ["製造", "不動産", "士業", "医療", "小売", "その他"],
  services: ["AI / DX", "システム開発", "PCレンタル", "ホームページ改善", "地方創生", "ENGER", "その他"],
  prefectures: ["北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県",
    "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県",
    "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県",
    "高知県", "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"],
};
const CSV_COLUMNS = [["name", "企業名", true], ["siteUrl", "企業サイトURL"], ["formUrl", "問い合わせフォームURL"], ["industry", "業種"],
  ["region", "都道府県"], ["address", "所在地"], ["service", "提案サービス"], ["phone", "電話番号"], ["emails", "メールアドレス"], ["size", "企業規模"], ["note", "メモ"]]
  .map(([key, label, required]) => ({ key, label, ...(required ? { required } : {}) }));

const CAMPAIGNS = [{ id: "cp1", name: "秋の製造業" }, { id: "cp2", name: "冬の不動産" }];

async function openAs({ roles = ["sales"], isAdmin = false, recent = null, recentOther = null, timerex = true, many = 0, failList = false, importFailChunk = 0, extra = [],
  deals: dealSeed = [], dealsNotReady = false, dealsTruncated = false, analytics = null, analyticsSince = null,
  repCounts = null } = {}) {
  const calls = [];
  // 企業詳細の応答を遅らせる／失敗させる（ドロワーの競合を再現するため）。テストの途中で書き換えてよい
  const ctl = { delay: {}, fail: new Set() };
  const meetings = [];
  // 案件（db/116）。本物（api/sales/deals）と同じ形で返す
  const deals = dealSeed.map((d) => ({ ...d }));
  const PROB = { meeting: 20, proposal: 50, negotiation: 80 };
  const STAGE = { meeting: "商談", proposal: "提案", negotiation: "最終調整", won: "成約", lost: "失注" };
  const shapeD = (d) => {
    const open = ["meeting", "proposal", "negotiation"].includes(d.stage);
    const p = open ? d.probability ?? PROB[d.stage] : null;
    return { approachId: null, ownerName: "営業 一郎", probability: null, lostReason: null, wonOn: null, lostOn: null,
      createdAt: NOW, ...d, stageLabel: STAGE[d.stage], open, probabilityUsed: p,
      expected: open && d.amount != null ? Math.round((d.amount * p) / 100) : 0 };
  };
  // lib/sales-timerex.js companyEmails と同じ：連絡先のメール・連絡手段がメールのときの連絡先・メールアドレス（emails[]）
  const emailsOf = (c) => [...new Set([c?.contacts?.email, c?.contactChannel === "email" ? c?.contactValue : null, ...(c?.emails || [])]
    .filter(Boolean).map((v) => String(v).toLowerCase()))];
  const shapeM = (m) => ({ kindLabel: "初回商談", durationMin: 30, ownerName: "営業 一郎",
    statusLabel: { scheduling: "日程調整中", scheduled: "商談予定", canceled: "取りやめ" }[m.status], ...m });
  const companies = [
    company({}),
    company({ id: "c2", name: "反応商事", domain: "hannou.jp", status: "clicked", statusLabel: "クリックあり",
      attackCount: 1, lastSentAt: NOW, clickCount: 2, firstClickAt: NOW, lastClickAt: NOW, unhandledClick: true,
      next: "クリックあり・要フォロー", nextKey: "follow_click", nextDue: TODAY }),
    // 返信まで進んだ会社（クリック1回・対応済み）。リードでは、クリックだけの会社より上に出る
    company({ id: "c3", name: "返信工業", domain: "henshin.jp", status: "replied", statusLabel: "返信あり",
      attackCount: 1, lastSentAt: NOW, clickCount: 1, firstClickAt: NOW, lastClickAt: NOW, unhandledClick: false,
      next: "返信対応", nextKey: "manual", nextDue: TODAY }),
  ];
  // ページングを見るための企業（many 社）
  for (let i = 1; i <= many; i++) {
    companies.push(company({ id: `m${i}`, name: `企業${String(i).padStart(3, "0")}`, domain: `m${i}.jp`,
      industry: ["士業", "製造"][i % 2], region: ["東京都", "大阪府", "福岡県"][i % 3] }));
  }
  for (const c of extra) companies.push(company(c));
  // 業種・提案サービスの選択肢（本物は db/108 gw_sales_master_options・api/sales/masters）
  const options = [
    ...MASTERS.industries.map((label, i) => ({ id: `mi${i}`, kind: "industry", label, sortOrder: i, archived: false })),
    ...MASTERS.services.map((label, i) => ({ id: `ms${i}`, kind: "service", label, sortOrder: i, archived: false })),
  ];
  const masterLists = () => ({
    industries: options.filter((o) => o.kind === "industry" && !o.archived).map((o) => o.label),
    services: options.filter((o) => o.kind === "service" && !o.archived).map((o) => o.label),
    prefectures: MASTERS.prefectures,
  });
  const ctlList = { fail: failList, delay: 0 };
  const page = await br.newPage({ viewport: { width: 1300, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "sales@8grp.co.jp" }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => d.accept());

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    const body = () => JSON.parse(req.postData() || "{}");

    if (/\/api\/me\b/.test(url)) {
      return send({ email: "sales@8grp.co.jp", appRole: isAdmin ? "admin" : "member", isAdmin, shows: {},
        gw: { employee: SALES, roles, isAdmin, tenantId: "t1", stage: null } });
    }
    if (/\/api\/sales\/companies\/export/.test(url)) {
      const sp = new URL(url).searchParams;
      calls.push({ kind: "export", method: req.method(), params: Object.fromEntries(sp.entries()), body: req.method() === "POST" ? body() : null });
      return route.fulfill({ status: 200, contentType: "text/csv; charset=utf-8",
        headers: { "Content-Disposition": `attachment; filename="sales_companies_2026-09-29.csv"; filename*=UTF-8''sales_companies_2026-09-29.csv` },
        body: "\ufeff企業名,URL\r\n株式会社サンプル,https://sample.co.jp/\r\n" });
    }
    if (/\/api\/sales\/companies\/bulk/.test(url)) {
      const b = body();
      calls.push({ kind: `bulk-${b.action}${b.dryRun ? "-dry" : ""}`, body: b });
      const hit = companies.filter((c) => b.ids.includes(c.id));
      // 本物（api/sales/companies/bulk.js）と同じく、アタック・クリック・成約・営業禁止のある企業は消さない
      const why = (c) => [c.attackCount && "アタック履歴あり", c.clickCount && "クリック履歴あり",
        c.status === "won" && "成約済み", c.ngReason && "営業禁止"].filter(Boolean);
      if (b.action === "delete") {
        const ok = hit.filter((c) => !why(c).length);
        const blocked = hit.filter((c) => why(c).length).map((c) => ({ id: c.id, name: c.name, reasons: why(c) }));
        if (b.dryRun) return send({ dryRun: true, notFound: 0, deletable: ok.map((c) => ({ id: c.id, name: c.name })), blocked });
        for (const c of ok) companies.splice(companies.indexOf(c), 1);
        return send({ deleted: ok.length, failed: 0, notFound: 0, blocked });
      }
      const HIDE = { link_broken: "リンク切れ", closed: "閉業", not_target: "営業対象外" };
      for (const c of hit) {
        if (b.action === "hide") { c.hidden = true; c.hiddenReason = b.reason; c.hiddenLabel = HIDE[b.reason] || b.reason; }
        if (b.action === "unhide") { c.hidden = false; c.hiddenReason = null; c.hiddenLabel = null; }
        if (b.action === "change_status") { c.status = b.status; c.statusLabel = { lost: "失注", excluded: "対象外" }[b.status] || b.status; }
        if (b.action === "change_owner") { c.ownerId = b.ownerId; c.ownerName = b.ownerId ? "営業 一郎" : null; }
      }
      return send({ updated: hit.length, skipped: 0, failed: 0, notFound: 0 });
    }
    // CSV取込（本物は api/sales/companies/import.js）：業種・商材はマスターだけ、都道府県は先頭一致、ドメインで重複
    if (/\/api\/sales\/companies\/import/.test(url)) {
      const b = body();
      calls.push({ kind: b.commit ? "csv-commit" : "csv-preview", body: b });
      if (b.commit && importFailChunk && calls.filter((c) => c.kind === "csv-commit").length === importFailChunk) {
        return send({ error: "db_failed", detail: "わざと失敗" }, 500);
      }
      const dom = (u) => { try { return new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, ""); } catch { return null; } };
      const seen = new Map();
      const results = b.rows.map((r) => {
        const reasons = [];
        if (!r.name) reasons.push("企業名がありません");
        if (r.industry && !MASTERS.industries.includes(r.industry)) reasons.push(`業種「${r.industry}」はマスターにありません`);
        if (r.service && !MASTERS.services.includes(r.service)) reasons.push(`提案サービス「${r.service}」はマスターにありません`);
        const pref = r.region ? MASTERS.prefectures.find((p) => r.region.startsWith(p) || r.region.startsWith(p.replace(/[都府県]$/, ""))) : null;
        if (r.region && !pref) reasons.push(`都道府県「${r.region}」を判定できません`);
        const d = r.siteUrl ? dom(r.siteUrl) : null;
        const show = { name: r.name, siteUrl: r.siteUrl, industry: r.industry, region: pref || r.region, service: r.service, domain: d };
        if (reasons.length) return { row: r.row, status: "error", reasons, ...show };
        const ex = companies.find((c) => c.domain === d);
        if (d && ex) return { row: r.row, status: "duplicate", reasons: [`登録済みのためスキップ（${ex.name}）`], ...show };
        if (d && seen.has(d)) return { row: r.row, status: "duplicate", reasons: [`CSV内で重複（${seen.get(d)}行目と同じサイト）`], ...show };
        if (d) seen.set(d, r.row);
        if (b.commit) {
          companies.push(company({ id: `csv${r.row}`, name: r.name, domain: d, siteUrl: r.siteUrl, industry: r.industry || null,
            region: pref, service: r.service || null }));
          return { row: r.row, status: "created", reasons: [], ...show };
        }
        return { row: r.row, status: "ok", reasons: [], ...show };
      });
      const counts = { read: results.length };
      for (const k of b.commit ? ["created", "duplicate", "error"] : ["ok", "duplicate", "error"]) counts[k] = results.filter((x) => x.status === k).length;
      return send({ results, counts });
    }
    if (/\/api\/sales\/masters\b/.test(url)) {
      const b = req.method() === "GET" ? {} : body();
      calls.push({ kind: `masters-${req.method()}`, body: b });
      if (req.method() === "POST") {
        if (options.some((o) => o.kind === b.kind && o.label === b.label)) return send({ error: "duplicate", hint: `「${b.label}」はもうあります` }, 409);
        const o = { id: `mo${options.length}`, kind: b.kind, label: b.label.trim(), sortOrder: 99, archived: false };
        options.push(o);
        return send({ option: o });
      }
      if (req.method() === "PATCH") {
        const o = options.find((x) => x.id === b.id);
        if (typeof b.archived === "boolean") o.archived = b.archived;
        if (b.label) {
          for (const c of companies) if (c[o.kind] === o.label) c[o.kind] = b.label;
          o.label = b.label;
        }
        return send({ ok: true });
      }
      return send({ kinds: [{ key: "industry", label: "業種" }, { key: "service", label: "提案サービス" }],
        options: options.map((o) => ({ ...o, used: companies.filter((c) => c[o.kind] === o.label).length })) });
    }
    if (/\/api\/sales\/campaigns\b/.test(url)) {
      return send({ campaigns: [{ id: "cp1", name: "秋の製造業", archived: false }] });
    }
    if (/\/api\/sales\/companies\/detail/.test(url)) {
      const id = new URL(url).searchParams.get("id") || body().id;
      calls.push({ kind: "detail", id, method: req.method() });
      if (ctl.delay[id]) await new Promise((r) => setTimeout(r, ctl.delay[id]));
      if (ctl.fail.has(id)) return send({ error: "db_failed", detail: "わざと失敗" }, 500);
      const c = companies.find((x) => x.id === id);
      if (req.method() === "PATCH" && body().contacts) {
        calls.push({ kind: "patch-contacts", body: body() });
        c.contacts = { ...c.contacts, ...body().contacts };
        return send({ company: c });
      }
      // 基本情報の編集（本物は PATCH /api/sales/companies/detail → normalizeCompany）。名前を含む PATCH
      if (req.method() === "PATCH" && body().name !== undefined) {
        const b = body();
        calls.push({ kind: "patch-basic", body: b });
        for (const k of ["name", "siteUrl", "formUrl", "industry", "region", "service", "phone", "address", "note"]) {
          if (b[k] !== undefined) c[k] = b[k];
        }
        return send({ company: c });
      }
      // 本物（lib/sales.js parseEmails）と同じ：小文字・重複除去して emails[] に
      if (req.method() === "PATCH" && body().emails !== undefined) {
        calls.push({ kind: "patch-emails", body: body() });
        c.emails = [...new Set([].concat(body().emails).flatMap((x) => String(x).split(/[,，、;；\s]+/))
          .map((x) => x.trim().toLowerCase()).filter(Boolean))];
        return send({ company: c });
      }
      if (req.method() === "POST" && body().action === "contact") {
        const b = body();
        calls.push({ kind: "contact", body: b });
        const LBL = { email: "メール", instagram: "Instagram", line: "LINE" };
        if (b.contactChannel) { c.contactChannel = b.contactChannel; c.contactChannelLabel = LBL[b.contactChannel] || b.contactChannel; }
        c.contacts = { ...c.contacts, ...(b.contacts || {}) };
        c.contactValue = c.contacts[c.contactChannel] || null;
        if (b.replied) { c.status = "replied"; c.statusLabel = "返信あり"; c.replyChannel = b.replyChannel; }
        return send({ company: c });
      }
      const ch = (keys) => keys.map(([key, label]) => ({ key, label }));
      return send({
        today: TODAY, company: c, approaches: [], recent,
        contactStatus: {
          firstChannelLabel: c.lastSentAt ? "お問い合わせフォーム" : null,
          replyChannelLabel: c.replyChannel === "instagram" ? "Instagram" : null,
          currentChannelLabel: c.contactChannelLabel, currentValue: c.contactValue,
          lastContactAt: c.lastSentAt,
        },
        sendChannels: ch([["form", "お問い合わせフォーム"], ["email", "メール"], ["instagram", "Instagram"], ["x", "X"]]),
        replyChannels: ch([["form", "お問い合わせフォーム経由"], ["email", "メール"], ["instagram", "Instagram"], ["phone", "電話"]]),
        contactChannels: ch([["email", "メール"], ["line", "LINE"], ["instagram", "Instagram"], ["phone", "電話"]]),
        sendFailReasons: ch([["no_form", "問い合わせフォームがない"], ["captcha", "CAPTCHA等で送信できない"], ["other", "その他"]]),
        hideReasons: ch([["link_broken", "リンク切れ"], ["other", "その他"]]),
        timeline: c.lastSentAt ? [{ at: c.lastSentAt, kind: "attack", label: "フォーム送信" },
          { at: c.lastClickAt, kind: "click", label: "リンククリック" }] : [],
        canForce: isAdmin, members: [{ id: "emp-s1", display_name: "営業 一郎" }], campaigns: [],
        meetings: meetings.filter((m) => m.companyId === id).map(shapeM), meetingsReady: true, timerexConfigured: timerex,
        deals: deals.filter((d) => d.companyId === id).map(shapeD), dealsReady: !dealsNotReady,
        matchEmails: emailsOf(c),
        // 本物と同じ：基本情報の編集の選択肢（共通マスター）。リード一覧はここから受け取る
        masters: MASTERS,
        statuses: [{ key: "untouched", label: "未アタック" }, { key: "attacked", label: "アタック済" }],
        ngReasons: [{ key: "no_sales", label: "営業禁止" }],
        eventKinds: [{ key: "follow", label: "フォロー" }, { key: "reply", label: "返信あり" }],
      });
    }
    if (/\/api\/sales\/deals\b/.test(url)) {
      if (dealsNotReady) return send({ error: "not_ready", message: "db/116_sales_deals.sql を実行してください" }, 503);
      if (req.method() === "POST") {
        const b = body();
        calls.push({ kind: "deal-create", body: b });
        const d = { id: `d${deals.length + 1}`, companyId: b.companyId, title: b.title, stage: b.stage || "meeting",
          amount: b.amount == null ? null : Number(b.amount), probability: b.probability ?? null };
        deals.push(d);
        return send({ deal: shapeD(d), companyStatus: "meeting", suggestCompanyLost: false });
      }
      if (req.method() === "PATCH") {
        const b = body();
        calls.push({ kind: "deal-update", body: b });
        const d = deals.find((x) => x.id === b.id);
        Object.assign(d, { stage: b.stage ?? d.stage, title: b.title ?? d.title, lostReason: b.lostReason ?? d.lostReason,
          amount: "amount" in b ? (b.amount == null ? null : Number(b.amount)) : d.amount });
        if (d.stage === "won") d.wonOn = TODAY;
        if (d.stage === "lost") d.lostOn = TODAY;
        const mine = deals.filter((x) => x.companyId === d.companyId);
        return send({ deal: shapeD(d), companyStatus: null, suggestCompanyLost: mine.every((x) => x.stage === "lost") });
      }
      return send({ deals: deals.map(shapeD), truncated: dealsTruncated });
    }
    if (/\/api\/sales\/meetings\b/.test(url)) {
      const b = body();
      calls.push({ kind: `meeting-${req.method()}`, body: b });
      if (req.method() === "POST") {
        // 本物と同じ：進行中の商談があれば新しく作らない。TimeRex を使うのにメールが無ければ断る
        const open = meetings.find((x) => x.companyId === b.companyId && ["scheduling", "scheduled"].includes(x.status));
        if (open) return send({ meeting: shapeM(open), reused: true, timerexConfigured: timerex });
        if (timerex && !emailsOf(companies.find((x) => x.id === b.companyId)).length) {
          return send({ error: "email_required", hint: "予約の照合に使うメールアドレスを先に登録してください" }, 400);
        }
        const m = { id: `m${meetings.length + 1}`, companyId: b.companyId, ownerId: b.ownerId || "emp-s1", kind: "first_meeting",
          status: "scheduling", schedulingUrl: timerex ? `https://timerex.net/s/eight/first30?sales_company_id=${b.companyId}&sales_meeting_id=m${meetings.length + 1}` : null,
          schedulingSentAt: null, scheduledAt: null, meetingUrl: null };
        meetings.push(m);
        return send({ meeting: shapeM(m), reused: false, timerexConfigured: timerex });
      }
      const m = meetings.find((x) => x.id === b.id);
      if (b.action === "sent") m.schedulingSentAt = NOW;
      if (b.action === "schedule") { m.status = "scheduled"; m.scheduledAt = b.scheduledAt; m.meetingUrl = b.meetingUrl; }
      if (b.action === "cancel") m.status = "canceled";
      return send({ meeting: shapeM(m) });
    }
    if (/\/api\/sales\/lookup\b/.test(url)) {
      const u = new URL(url).searchParams.get("url");
      calls.push({ kind: "lookup", url: u });
      if (/sample\.co\.jp/.test(u)) return send({ url: u, domain: "sample.co.jp", duplicate: { id: "c1", name: "株式会社サンプル" }, ok: true });
      if (/noname/.test(u)) return send({ url: `https://${new URL(u).hostname}/`, domain: new URL(u).hostname, duplicate: null, ok: false, reason: "http" });
      const host = new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, "");
      return send({ url: `https://${host}/`, domain: host, duplicate: null, ok: true,
        name: `株式会社${host.split(".")[0].toUpperCase()}`, formUrl: `https://${host}/contact/`, phone: "03-1234-5678", address: null });
    }
    if (/\/api\/sales\/companies\b/.test(url)) {
      if (req.method() === "POST") {
        const b = body();
        calls.push({ kind: b.companies ? "bulk" : "create", body: b });
        if (b.companies) return send({ created: b.companies.length, skipped: 0 });
        const made = company({ id: "c-new", name: b.name, siteUrl: b.siteUrl, formUrl: b.formUrl, service: b.service,
          industry: b.industry ?? null, region: b.region ?? null, domain: b.siteUrl ? new URL(b.siteUrl).hostname.replace(/^www\./, "") : null,
          // 本物（lib/sales.js parseEmails）と同じ：区切って小文字・重複なし
          emails: [...new Set(String(b.emails || "").split(/[,，、;；\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))] });
        companies.push(made);
        return send({ company: made });
      }
      // 本物（api/sales/companies?page=…）と同じ：サーバーで絞って並べて100件に切る
      const sp = new URL(url).searchParams;
      const vis = sp.get("visibility") || "shown";
      const params = Object.fromEntries(sp.entries());
      calls.push({ kind: "list", visibility: vis, params });
      if (ctlList.delay) await new Promise((r) => setTimeout(r, ctlList.delay));
      if (ctlList.fail) return send({ error: "db_failed", detail: "わざと失敗" }, 500);
      const base = companies.filter((c) => (vis === "all" ? true : vis === "hidden" ? c.hidden : !c.hidden));
      const q = (sp.get("q") || "").toLowerCase();
      const inQ = base.filter((c) => !q || `${c.name} ${c.domain}`.toLowerCase().includes(q));
      const prefOf = (r) => MASTERS.prefectures.find((p) => String(r || "").startsWith(p)) || null;
      const hit = (c, k) => !sp.get(k) || (k === "region"
        ? (sp.get(k) === "none" ? !prefOf(c.region) : String(c.region || "").startsWith(sp.get(k))) : c[k] === sp.get(k));
      const FK = ["industry", "region", "service", "status"];
      // アタック画面（本物は lib/sales.js applyListFilters の queue=attack・owner=mine・campaign・next）
      const cutoff = Date.now() - 30 * 86400000;
      const extra = (c) => (sp.get("queue") !== "attack" || (!c.ngReason && ["untouched", "reattack_wait"].includes(c.status)
          && (!c.lastSentAt || new Date(c.lastSentAt).getTime() < cutoff) && (!c.nextDue || c.nextDue <= TODAY)))
        && (sp.get("owner") !== "mine" || c.ownerId === "emp-s1" || !c.ownerId)
        && (!sp.get("campaign") || (sp.get("campaign") === "none" ? !c.campaignId : c.campaignId === sp.get("campaign")))
        && (!sp.get("next") || c.nextKey === sp.get("next"));
      let listed = inQ.filter((c) => FK.every((k) => hit(c, k)) && extra(c));
      const sortKey = { name: "name", industry: "industry", region: "region", clicks: "clickCount" }[sp.get("sort")];
      if (sortKey) {
        const dir = sp.get("order") === "desc" ? -1 : 1;
        listed = [...listed].sort((a, b) => (a[sortKey] < b[sortKey] ? -dir : a[sortKey] > b[sortKey] ? dir : (a.id < b.id ? -1 : 1)));
      }
      const members = [{ id: "emp-s1", display_name: "営業 一郎" }];
      // 一覧には進行中の商談の段階（本物の meetingStatus・meetingAt）を載せる
      listed = listed.map((c) => {
        const m = meetings.find((x) => x.companyId === c.id && ["scheduling", "scheduled"].includes(x.status));
        return m ? { ...c, meetingStatus: m.status, meetingAt: m.scheduledAt || null } : c;
      });
      if (sp.get("view") === "dashboard") {
        return send({ today: TODAY, view: "dashboard", total: listed.length, sections: dashboardSections(listed, { today: TODAY }) });
      }
      if (!sp.has("page")) return send({ today: TODAY, me: "emp-s1", members, companies: listed });
      const limit = 100;
      const total = listed.length;
      const totalPages = Math.max(1, Math.ceil(total / limit));
      const page = Math.min(Math.max(1, Number(sp.get("page")) || 1), totalPages);
      // 本物（db/101）と同じ：各項目の件数は「その項目以外の条件（検索語を含む）」で数える。並べ替え・ページは関係しない
      // 地域は都道府県にまとめる（本物は gw_sales_prefecture）
      const pref = prefOf;
      const facet = (k) => {
        const rows = inQ.filter((c) => FK.every((o) => o === k || hit(c, o)));
        const m = new Map();
        for (const c of rows) {
          const v = k === "region" ? pref(c.region) || "none" : c[k];
          if (v) m.set(v, (m.get(v) || 0) + 1);
        }
        return [...m].map(([value, n]) => ({ value, n }));
      };
      return send({ today: TODAY, me: "emp-s1", members, page, limit, total, totalPages,
        companies: listed.slice((page - 1) * limit, page * limit).map((c) => ({ ...c, region: pref(c.region) })),
        masters: masterLists(), csvColumns: CSV_COLUMNS, campaigns: CAMPAIGNS,
        nextFilters: [["follow_click", "クリックあり・要フォロー"], ["manual", "決めたNEXT"], ["attack", "フォームアタック"],
          ["decide", "NEXTを決める"], ["none", "やること無し"]].map(([key, label]) => ({ key, label })),
        facets: sp.get("facets") === "1" ? { dynamic: true, total, industry: facet("industry"), region: facet("region"),
          service: facet("service"), status: facet("status"), owner: facet("ownerId") } : undefined });
    }
    if (/\/api\/sales\/templates\b/.test(url)) {
      return send({ services: [], templates: [{ id: "t1", name: "DX基本", service: "AI / DX", subject: null,
        body: "{{company}}\nご担当者様\n\n{{sender}}です。\n詳細はこちら\n{{url}}", destinationUrl: "https://8grp.co.jp/service/dx",
        archived: false, uses: 0 }] });
    }
    // 担当者別フォームアタック数（本物は api/sales/approaches/counts.js）
    if (/\/api\/sales\/approaches\/counts/.test(url)) {
      const sp = new URL(url).searchParams;
      calls.push({ kind: "counts", params: Object.fromEntries(sp.entries()) });
      if (repCounts) return send(repCounts(Object.fromEntries(sp.entries())));
      return send({ period: { key: sp.get("period") || "this_week", label: "今週", from: TODAY, to: TODAY, days: 1 },
        rows: [], total: 0, zeroMembers: "listed" });
    }
    if (/\/api\/sales\/approaches\b/.test(url)) {
      if (req.method() === "POST") {
        calls.push({ kind: "prepare", body: body() });
        // 本物と同じ：直近に送ったチャネルと同じなら recent_attack（押し切りは管理者の force だけ）。
        // 別チャネルなら「別チャネルで送る」（acknowledgeRecent）を選ぶまで recent_other_channel
        const b = body();
        const last = recent || recentOther;
        const ch = b.channel || "form";
        if (last && !b.force && ch === last.channel) {
          return send({ error: "recent_attack", recent: last, canForce: isAdmin,
            hint: `直近30日以内に${last.channelLabel}でアタックされています` }, 409);
        }
        if (last && !b.force && !b.acknowledgeRecent) {
          return send({ error: "recent_other_channel", recent: last, hint: `3日前に${last.channelLabel}から送信済みです` }, 409);
        }
        return send({ approach: { id: "ap1", trackingToken: "X7K92PABCD", sentAt: null },
          trackingUrl: "https://gw.8grp.co.jp/r/X7K92PABCD" });
      }
      if (req.method() === "PATCH") {
        calls.push({ kind: "act", body: body() });
        return send({ approach: { id: "ap1", sentAt: NOW } });
      }
      return send({ approaches: analytics || [], ...(analyticsSince ? { since: analyticsSince } : {}) });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });
  return { page, calls, errs, ctl, ctlList, meetings, companies };
}

console.log("\n=== 営業担当：ダッシュボード ===");
{
  const { page, errs } = await openAs();
  await page.goto(`${BASE}/sales/index.html`);
  await page.waitForTimeout(1000);

  check((await page.locator(".sl-logo").innerText()).includes("SALES"), "EIGHT/SALES のロゴが出る");
  const nav = await page.locator(".sl-nav a").allInnerTexts();
  check(nav.length === 5, `ナビは5つ（いま ${nav.length}: ${nav.join(" / ")}）`);
  check(["ダッシュボード", "企業", "アタック", "リード", "分析"].every((l) => nav.some((t) => t.includes(l))),
    "ダッシュボード／企業／アタック／リード／分析");
  check(!nav.some((t) => t.includes("反応")), "「反応」タブは無くなった（リードへ）");
  check((await page.locator(".sl-nav a.on").innerText()).includes("ダッシュボード"), "いま見ているタブが選ばれている");

  const order = await page.locator(".db-sec .db-sec-h .t").allInnerTexts();
  check(order.join("|") === "🔥 ① リード・未対応|② 返信あり|③ 今日フォロー|④ 今日アタック|⑤ 最近の営業履歴",
    `上から クリック→返信→フォロー→アタック→履歴（いま ${order.join(" / ")}）`);
  check(await page.locator(".db-sec").first().evaluate((e) => e.id) === "sec-click", "いちばん上はリード・未対応");
  const bg = await page.locator("#sec-click").evaluate((e) => getComputedStyle(e).backgroundColor);
  check(bg !== "rgba(0, 0, 0, 0)", `クリックありは色で目立たせる（${bg}）`);
  check((await page.locator("#list-click").innerText()).includes("反応商事"), "クリックした企業が①に出る");
  check((await page.locator(".db-sum a.hot").innerText()).includes("リード・未対応"), "件数の段でもリード・未対応を強調");
  check(/1\s*社/.test(await page.locator(".db-sum a.hot").innerText()), "リード・未対応は1社");
  check((await page.locator("#list-attack").innerText()).includes("株式会社サンプル"), "未アタックの企業は④に出る");
  check(!(await page.locator("#list-attack").innerText()).includes("反応商事"), "①に出した企業は下の段に重ねて出さない");
  check((await page.locator("#history").innerText()).includes("直近14日の送信はありません"), "最近の営業履歴の段が出る（送信なし）");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 営業担当：企業 → フォームアタック → 送信完了 ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/companies.html`);
  await page.waitForTimeout(1000);

  check((await page.locator("#rows tr").count()) === 3, "一覧に3社");
  await page.locator("#rows tr", { hasText: "株式会社サンプル" }).click();
  await page.waitForTimeout(500);
  check(await page.locator(".sl-detail").isVisible(), "右ドロワーで詳細が開く");
  check((await page.locator(".sl-next h3").innerText()).includes("フォームアタック"), "NEXTはフォームアタック");

  await page.locator(".sl-next button", { hasText: "フォームアタック" }).click();
  await page.waitForTimeout(800);
  check(await page.locator(".atk").isVisible(), "フォームアタック画面が開く");
  const text = await page.locator("#at-body").inputValue();
  check(text.startsWith("株式会社サンプル"), "企業名が差し込まれる");
  check(text.includes("営業 一郎"), "送る人の名前が差し込まれる");
  check(text.includes("https://gw.8grp.co.jp/r/X7K92PABCD"), "専用URLが本文に入る");
  check(calls.some((c) => c.kind === "prepare" && c.body.companyId === "c1" && c.body.templateId === "t1"),
    "開いた時点で専用URLを発行している（テンプレートつき）");
  check(await page.locator(".atk a", { hasText: "問い合わせフォームを開く" }).count() === 1, "フォームを開くボタンがある");

  check((await page.locator("#at-channel").inputValue()) === "form", "送信チャネルの初期値はお問い合わせフォーム");
  await page.locator("button", { hasText: "送信完了" }).click();
  await page.locator(".sl-modal").waitFor();
  check(await page.locator('.sl-modal input[name="sd-channel"][value="form"]').isChecked(), "送信完了モーダル：チャネルが選ばれている");
  check(!calls.some((c) => c.kind === "act"), "モーダルで記録するまでは送らない");
  await page.locator(".sl-modal button", { hasText: "記録する" }).click();
  await page.waitForTimeout(800);
  const sent = calls.find((c) => c.kind === "act");
  check(sent && sent.body.action === "sent" && sent.body.id === "ap1", "送信完了を記録した");
  check(sent && sent.body.channel === "form", "送信チャネル（フォーム）を送る");
  check(sent && sent.body.body.includes("/r/X7K92PABCD"), "送った本文（専用URLつき）を残す");
  check(sent && sent.body.service === "AI / DX", "提案サービスも残す");
  check(!(await page.locator(".atk").count()), "送信完了で閉じる");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 直近30日以内：警告して送らせない ===");
{
  const recent = { sentAt: NOW, employeeName: "営業 二郎", service: "PCレンタル", days: 30, channel: "form", channelLabel: "お問い合わせフォーム" };
  const { page, errs } = await openAs({ recent });
  await page.goto(`${BASE}/sales/companies.html?id=c1`);
  await page.waitForTimeout(1000);
  check((await page.locator(".sl-detail").innerText()).includes("営業 二郎さんがお問い合わせフォームから送信済みです"),
    "企業ページに「〇〇さんが〇〇から送信済みです」");

  await page.goto(`${BASE}/sales/companies.html?attack=c1`);
  await page.waitForTimeout(1000);
  const t = await page.locator(".atk").innerText();
  check(t.includes("直近30日以内にお問い合わせフォームでアタックされています"), "警告が出る（どのチャネルで送ったか）");
  check(t.includes("営業 二郎") && t.includes("PCレンタル"), "前回の担当・サービスが出る");
  check(!(await page.locator("#at-body").count()), "営業文は出さない");
  check(!(await page.locator("button", { hasText: "それでもアタックする" }).count()), "営業担当には押し切りボタンを出さない");
  // 別のチャネル（Instagram など）なら送れる
  check(!(await page.locator('#at-other-channel option[value="form"]').count()), "別チャネルの候補に、止められたチャネルは出さない");
  await page.locator("#at-other-channel").selectOption("instagram");
  await page.locator("button", { hasText: "別チャネルで送る" }).click();
  await page.locator("#at-body").waitFor();
  check((await page.locator("#at-channel").inputValue()) === "instagram", "別チャネル（Instagram）の営業文画面に進める");
  check((await page.locator("#at-recent-banner").innerText()).includes("お問い合わせフォームから送信済みです"),
    "営業文画面にも直近の接触を出したまま");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();

  // 押し切りできるのは Sales を使える人の中の経営者・管理者（社内権限 owner）
  const admin = await openAs({ recent, isAdmin: true, roles: ["owner"] });
  await admin.page.goto(`${BASE}/sales/companies.html?attack=c1`);
  await admin.page.waitForTimeout(1000);
  check(await admin.page.locator("button", { hasText: "それでもアタックする" }).count() === 1, "管理者には押し切りボタンが出る");
  await admin.page.locator("button", { hasText: "それでもアタックする" }).click();
  await admin.page.waitForTimeout(800);
  check(admin.calls.some((c) => c.kind === "prepare" && c.body.force === true), "押し切りは force つきで頼む");
  check(await admin.page.locator("#at-body").count() === 1, "押し切ると営業文が出る");
  await admin.page.close();
}

console.log("\n=== 企業追加：URLだけで登録 → そのままアタックへ ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/companies.html?new=1`);
  await page.waitForTimeout(900);
  const drawer = page.locator(".sl-drawer");
  // 最初に見えているのは URL・企業名・提案サービスだけ。詳細は折りたたみ
  check(await page.locator("#q-url").isVisible() && await page.locator("#q-name").isVisible()
    && await page.locator("#q-service").isVisible(), "URL・企業名・提案サービスが見えている");
  check(!(await page.locator("#q-form").isVisible()) && !(await page.locator("#q-phone").isVisible())
    && !(await page.locator("#q-note").isVisible()), "フォームURL・電話・メモなどは折りたたまれている");
  check((await drawer.locator("button").first().innerText()).includes("追加してアタックへ"), "Primary は「追加してアタックへ」");

  await page.fill("#q-url", "https://www.abc-kogyo.co.jp/");
  await page.locator("#q-url").dispatchEvent("change");
  await page.waitForTimeout(700);
  check((await page.inputValue("#q-name")) === "株式会社ABC-KOGYO", `企業名が自動で入る（${await page.inputValue("#q-name")}）`);
  check((await page.inputValue("#q-form")) === "https://abc-kogyo.co.jp/contact/", "問い合わせフォームURLも裏で入る");
  check((await page.locator("#q-look").innerText()).includes("取得できました"), "何が取れたかを出す");

  await page.selectOption("#q-service", "PCレンタル");
  await page.locator("button", { hasText: "追加してアタックへ" }).click();
  await page.waitForTimeout(1200);
  const made = calls.find((c) => c.kind === "create");
  check(made && made.body.siteUrl === "https://www.abc-kogyo.co.jp/" && made.body.service === "PCレンタル"
    && made.body.formUrl === "https://abc-kogyo.co.jp/contact/", "URL・企業名・サービス・フォームURLで登録する");
  check(made && made.body.ownerId === undefined, "担当は送らない（サーバが登録した人にする）");
  check(await page.locator(".atk").isVisible(), "登録したら、そのままフォームアタック画面が開く");
  check((await page.locator("#at-body").inputValue()).startsWith("株式会社ABC-KOGYO"), "営業文に企業名が入っている");

  // 登録済みのドメインは、追加ボタンを押せない
  await page.goto(`${BASE}/sales/companies.html?new=1`);
  await page.waitForTimeout(700);
  await page.fill("#q-url", "sample.co.jp");
  await page.locator("#q-url").dispatchEvent("change");
  await page.waitForTimeout(600);
  check((await page.locator("#q-look").innerText()).includes("登録済みです"), "登録済みの企業は、その場で分かる");
  check(await page.locator("#q-go").isDisabled(), "登録済みなら「追加してアタックへ」は押せない");

  // サイトが開けなくても、URLだけで登録できる（企業名はドメイン名）
  await page.goto(`${BASE}/sales/companies.html?new=1`);
  await page.waitForTimeout(700);
  await page.fill("#q-url", "https://noname.example.jp");
  await page.locator("#q-url").dispatchEvent("change");
  await page.waitForTimeout(600);
  check((await page.locator("#q-look").innerText()).includes("URLだけで登録できます"), "取れなくても止めないと伝える");
  await page.locator("button", { hasText: "追加だけする" }).click();
  await page.waitForTimeout(900);
  const made2 = calls.filter((c) => c.kind === "create").pop();
  check(made2?.body.name === "noname.example.jp", `企業名が無ければドメイン名で登録（${made2?.body.name}）`);
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== URLをまとめて追加 ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/companies.html`);
  await page.waitForTimeout(900);
  await page.locator("button", { hasText: "URLをまとめて追加" }).click();
  await page.fill("#bu-text", [
    "https://aaa.co.jp", "bbb.jp", "https://www.aaa.co.jp/about", "https://sample.co.jp/", "hannou.jp", "ccc.com", "これはURLではない",
  ].join("\n"));
  await page.selectOption("#bu-service", "AI / DX");
  await page.locator("#bu-go").click();
  await page.waitForTimeout(2500);
  const bulk = calls.find((c) => c.kind === "bulk");
  const names = (bulk?.body.companies || []).map((c) => c.name).sort();
  check(JSON.stringify(names) === JSON.stringify(["株式会社AAA", "株式会社BBB", "株式会社CCC"]),
    `重複・登録済みを除いて3社（${names.join(", ")}）`);
  check(!calls.some((c) => c.kind === "lookup" && /hannou/.test(c.url)), "一覧にある企業のドメインは、取りにいく前に除く");
  check((bulk?.body.companies || []).every((c) => c.service === "AI / DX" && c.formUrl), "サービスとフォームURLも一緒に登録");
  check((await page.locator("#bu-progress").innerText()).includes("3社を追加しました"), "結果を出す");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== リード ===");
{
  const { page, errs } = await openAs();
  await page.goto(`${BASE}/sales/leads.html`);
  await page.waitForTimeout(1000);
  check((await page.locator(".sl-nav a.on").innerText()).includes("リード"), "上部タブの「リード」が選ばれている");
  const cards = await page.locator(".ld-card .nm").allInnerTexts();
  check(cards.length === 2, `反応した2社だけ（未アタックは出さない）（${cards.length}）`);
  check(cards[0]?.includes("返信工業") && cards[1]?.includes("反応商事"), `返信あり → クリックの順（${cards.map((c) => c.split("\n")[0]).join(" / ")}）`);
  check(cards[0]?.includes("リード") && cards[1]?.includes("ウォームリード"), "返信はリード、クリックだけはウォームリード");
  check(cards[1]?.includes("🔥"), "未対応クリックは🔥");
  const meta = await page.locator(".ld-card").nth(1).innerText();
  check(meta.includes("クリック 2回") && meta.includes("NEXT：クリックあり・要フォロー"), "クリック回数とNEXTを出す");
  const tabs = await page.locator("#stages button").allInnerTexts();
  check(["すべて", "クリックあり", "返信あり", "予約待ち", "商談予定", "提案中", "成約"].every((l) => tabs.some((t) => t.startsWith(l))), `段階で絞れる（${tabs.join(" / ")}）`);
  const btns = await page.locator(".ld-card button").allInnerTexts();
  check(btns.length === 2 && btns.every((t) => t === "商談を予定する"), `リードのボタンは「商談を予定する」1つ（${btns.join(" / ")}）`);
  await page.locator("#stages button", { hasText: "返信あり" }).click();
  check((await page.locator(".ld-card").count()) === 1, "「返信あり」で絞ると1社");
  await page.locator(".ld-card").first().click();
  // 詳細の取得を待つ（ドロワーは「読み込み中…」で先に出る。中身＝NEXT ACTION が出るまで待つ。
  // CI は遅いので、決め打ちの待ち時間にしない）
  await page.locator(".sl-detail #dt-next").waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  check(/\/sales\/leads\.html\?id=c3$/.test(page.url()) && await page.locator(".sl-detail").isVisible(),
    `開くとリード一覧のまま右ドロワー（画面遷移しない）（${page.url()}）`);
  const d = await page.locator(".sl-detail").innerText();
  check(d.includes("初回クリック") && d.includes("最終クリック"), "詳細に初回・最終クリックが出る");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 商談：リード一覧 → 右ドロワー → 商談を予定する → 中央モーダル → 閉じると同じドロワー ===");
{
  const { page, calls, errs } = await openAs();
  // 一覧の条件・スクロール位置が残ることを見るため、画面を低くして絞り込み・段階を選んでおく
  await page.setViewportSize({ width: 1300, height: 420 });
  await page.goto(`${BASE}/sales/leads.html`);
  await page.locator(".ld-card").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.selectOption("#f-owner", "me");
  await page.locator("#stages button", { hasText: "返信あり" }).click();
  await page.locator("#stages button", { hasText: "すべて" }).click();
  // 一覧が短いとスクロールできないので、ページの下に余白を足してから少し下へ
  await page.evaluate(() => { document.body.style.paddingBottom = "1200px"; window.scrollTo(0, 80); });
  const y0 = await page.evaluate(() => window.scrollY);

  // 1) リードを開く → 右ドロワー（NEXT ACTION が先頭。Primary は「商談を予定する」、Secondary は2つ）
  await page.locator(".ld-card", { hasText: "反応商事" }).click();
  await page.locator(".sl-detail #dt-next").waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  check(/\/sales\/leads\.html\?id=c2$/.test(page.url()), `画面遷移しない（${page.url()}）`);
  const firstBlock = await page.locator(".sl-detail > div").nth(1).getAttribute("id");
  check(firstBlock === "dt-next", `ドロワーは見出しのすぐ下に NEXT ACTION（${firstBlock}）`);
  check((await page.locator("#dt-next .lb").innerText()).includes("NEXT ACTION"), "「NEXT ACTION」と出す");
  const prim = await page.locator("#dt-next .btn-primary").allInnerTexts();
  const sec = await page.locator("#dt-next .sl-cta-sub .btn-secondary").allInnerTexts();
  check(prim.length === 1 && prim[0].includes("商談を予定する"), `Primary は「商談を予定する」1つ（${prim.join(" / ")}）`);
  check(sec.length === 2 && sec[0].includes("返信・やり取りを記録") && sec[1].includes("フォローを記録"),
    `Secondary は「返信・やり取りを記録」「フォローを記録」（${sec.join(" / ")}）`);
  check(await page.locator(".sl-detail button", { hasText: "フォームアタック" }).count() === 0, "リード一覧のドロワーからはフォームアタックを開かない");

  // 2) 商談を予定する → 中央モーダル（会社名・商談種類・担当・予約照合メール・営業状態）
  await page.locator("#dt-meeting").click();
  await page.locator(".sl-modal h2", { hasText: "商談を予定する" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  check(await page.locator(".sl-detail").isVisible() && await page.locator(".sl-modal").isVisible(), "ドロワーの上に中央モーダル");
  const info = await page.locator("#mt-info").innerText();
  check(info.includes("反応商事") && info.includes("初回商談（30分）") && info.includes("担当"), `会社名・商談種類・担当（${info.replace(/\s+/g, " ")}）`);
  check((await page.locator("#mt-stage").innerText()).trim() === "未送信", "営業状態は「未送信」（「状態：未設定」と出さない）");
  check(!(await page.locator(".sl-modal").innerText()).includes("未設定"), "「未設定」という曖昧な表示が無い");
  check((await page.locator(".sl-modal").innerText()).includes("予約照合に使うメールアドレス"), "予約照合に使うメールアドレスの欄");
  check(await page.locator("#mt-start").isDisabled(), "メールが無い間は「日程調整を開始」を押せない");

  // 3) メールをその場で登録 → 日程調整を開始
  await page.fill("#mt-email-input", "tanaka@hannou.jp");
  await page.locator("#mt-email-save").click();
  await page.locator("#mt-email").waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  check(calls.some((c) => c.kind === "patch-emails" && c.body.id === "c2" && c.body.emails.includes("tanaka@hannou.jp")),
    "メールは企業のメールアドレス（emails[]）に足す（企業一覧と同じ API）");
  check((await page.locator("#mt-email").innerText()).includes("tanaka@hannou.jp"), "照合に使うメールアドレスを明示");
  check(!(await page.locator("#mt-start").isDisabled()), "メールを登録すると押せる");
  check((await page.locator("#mt-start").innerText()).includes("日程調整を開始"), "ボタンは「日程調整を開始」");
  await page.locator("#mt-start").click();
  await page.locator("#mt-sched").waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  const sched = await page.inputValue("#mt-sched");
  check(/^https:\/\/timerex\.net\/s\/eight\/first30\?sales_company_id=c2&sales_meeting_id=m1$/.test(sched), `TimeRex URL に会社と商談のID（${sched}）`);
  check(calls.some((c) => c.kind === "meeting-POST" && c.body.companyId === "c2" && c.body.ownerId === "emp-s1"),
    "企業一覧と同じ API（POST /api/sales/meetings）で、担当つきで作る");
  check((await page.locator("#mt-stage").innerText()).trim() === "予約待ち", "作成後は「予約待ち」");
  check(await page.locator("#mt-copy", { hasText: "URLをコピー" }).isVisible(), "「URLをコピー」");
  check(await page.locator("#mt-open", { hasText: "予約ページを開く" }).getAttribute("href") === sched, "「予約ページを開く」は日程調整URLへ");
  check((await page.inputValue("#mt-mail")).includes("tanaka@hannou.jp"), "案内文に予約時のメールアドレスを入れる");

  // もう一度開いても新しい商談を作らない（予約待ちのまま）
  await page.locator(".sl-modal button", { hasText: "閉じる" }).click();
  await page.locator("#dt-meeting").click();
  await page.locator("#mt-stage").waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  check((await page.locator("#mt-stage").innerText()).trim() === "予約待ち" && await page.locator("#mt-start").count() === 0,
    "発行済みなら「予約待ち」。日程調整を開始をもう一度出さない");
  check(calls.filter((c) => c.kind === "meeting-POST").length === 1, "新しい商談は1件だけ");

  // 4) 閉じる → 同じリードのドロワーに戻る。一覧の条件・スクロール位置はそのまま
  await page.locator(".sl-modal button", { hasText: "閉じる" }).click();
  await page.waitForTimeout(300);
  check(await page.locator(".sl-modal").count() === 0, "モーダルが閉じる");
  check(await page.locator(".sl-detail").isVisible() && (await page.locator(".sl-detail").innerText()).includes("反応商事"), "同じリードのドロワーに戻る");
  check(/\/sales\/leads\.html\?id=c2$/.test(page.url()), `リード一覧のまま（${page.url()}）`);
  check((await page.locator(".sl-detail").innerText()).includes("予約待ち"), "ドロワーにも「予約待ち」");
  await page.locator(".sl-detail button", { hasText: "閉じる" }).first().click();
  await page.waitForTimeout(300);
  check(await page.locator(".sl-detail").count() === 0 && /\/sales\/leads\.html$/.test(page.url()), "ドロワーを閉じると一覧だけ（id を外す）");
  check(await page.inputValue("#f-owner") === "me", "絞り込み（担当）が残る");
  const onTab = await page.locator("#stages button.on").innerText();
  check(onTab.startsWith("すべて"), `段階タブが残る（${onTab}）`);
  check(await page.evaluate(() => window.scrollY) === y0, `スクロール位置が残る（${y0}）`);
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== リードのドロワーから基本情報を編集：業種・地域・提案サービスは共通マスターの選択肢 ===");
{
  const { page, errs } = await openAs();
  await page.goto(`${BASE}/sales/leads.html`);
  await page.locator(".ld-card").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.locator(".ld-card", { hasText: "反応商事" }).click();
  await page.locator(".sl-detail #dt-next").waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.locator(".sl-detail button", { hasText: "基本情報を編集" }).click();
  await page.locator(".sl-modal #c-region").waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  const opts = async (id) => page.locator(`#${id} option`).allInnerTexts();
  const region = await opts("c-region");
  check(region.length === MASTERS.prefectures.length + 1 && region.includes("東京都"), `地域は47都道府県から選ぶ（${region.length - 1}）`);
  check((await opts("c-industry")).length === MASTERS.industries.length + 1, "業種は共通マスター");
  check((await opts("c-service")).length === MASTERS.services.length + 1, "提案サービスは共通マスター");
  check(/\/sales\/leads\.html\?id=c2$/.test(page.url()), "リード一覧のまま（遷移しない）");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 商談：一覧のボタン → 日程確定 → 商談予定（手入力） ===");
{
  const { page, calls, errs, companies } = await openAs();
  // いまの連絡手段がメール（その連絡先も照合に使う。lib/sales-timerex.js companyEmails と同じ）
  Object.assign(companies.find((c) => c.id === "c3"), { contactChannel: "email", contactChannelLabel: "メール", contactValue: "info@henshin.jp" });
  await page.goto(`${BASE}/sales/leads.html`);
  await page.locator(".ld-card").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.locator(".ld-card", { hasText: "返信工業" }).locator("button", { hasText: "商談を予定する" }).click();
  await page.locator(".sl-modal h2", { hasText: "商談を予定する" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  check(/\/sales\/leads\.html\?id=c3$/.test(page.url()) && await page.locator(".sl-detail").isVisible(), "一覧のボタンでも、ドロワー＋中央モーダル（遷移しない）");
  check((await page.locator("#mt-email").innerText()).includes("info@henshin.jp"), "登録済みのメールを照合に使う");
  await page.locator("#mt-start").click();
  await page.locator("#mt-sched").waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.locator("button", { hasText: "送付済みにする" }).click();
  await page.waitForTimeout(900);
  check((await page.locator(".sl-modal").innerText()).includes("相手の予約を待っています"), "送付済みになる");

  await page.locator(".sl-modal summary", { hasText: "日程が決まった" }).click();
  await page.fill("#mt-when", "2099-10-05T14:00");
  await page.fill("#mt-url", "https://meet.google.com/abc-defg-hij");
  await page.locator("button", { hasText: "日程を確定" }).click();
  await page.waitForTimeout(900);
  const sc = calls.find((c) => c.kind === "meeting-PATCH" && c.body.action === "schedule");
  check(sc && sc.body.scheduledAt === "2099-10-05T05:00:00.000Z" && sc.body.meetingUrl === "https://meet.google.com/abc-defg-hij", "日時（JST 14:00）とMeet URLで確定");
  const d1 = await page.locator(".sl-modal").innerText();
  check((await page.locator("#mt-stage").innerText()).trim() === "商談予定" && await page.locator(".sl-modal a", { hasText: "商談に参加" }).count() === 1, "商談予定・「商談に参加」が出る");
  check(d1.includes("商談予定"), "見出しも「商談予定」");
  check((await page.locator(".sl-detail").innerText()).includes("初回商談（30分）"), "ドロワーの「商談」にも出る");
  check((await page.locator("#dt-meeting").innerText()).includes("商談予定を見る"), "ドロワーの CTA は「商談予定を見る」に変わる");
  await page.locator(".sl-modal button", { hasText: "閉じる" }).click();
  await page.locator(".sl-detail button", { hasText: "閉じる" }).first().click();
  await page.waitForTimeout(600);
  check((await page.locator(".ld-card", { hasText: "返信工業" }).locator("button").innerText()).includes("商談予定を見る"), "一覧のボタンも「商談予定を見る」");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();

  // TimeRex 未設定でも、面談を作って手入力で進められる
  const off = await openAs({ timerex: false });
  await off.page.goto(`${BASE}/sales/companies.html?id=c3&meeting=1`);
  await off.page.locator(".sl-modal h2", { hasText: "商談を予定する" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  check((await off.page.locator(".sl-modal").innerText()).includes("TIMEREX_SALES_MEETING_URL"), "未設定なら、そう出す");
  await off.page.locator("button", { hasText: "商談を作成" }).click();
  await off.page.waitForTimeout(900);
  check(await off.page.locator("#mt-when").isVisible(), "未設定なら手入力の欄を開いておく");
  await off.page.close();
}

console.log("\n=== 企業詳細：取得中に閉じる・切り替える（古い応答を捨てる） ===");
{
  const { page, errs, ctl, companies } = await openAs();
  companies.find((c) => c.id === "c2").contacts = { email: "tanaka@hannou.jp" };
  await page.goto(`${BASE}/sales/companies.html`);
  await page.locator("#list tr.click").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  const box = () => page.locator("#detail-box").count();

  // 1) 取得中にドロワーを閉じる → 応答が戻っても書かない・落ちない
  ctl.delay.c1 = 1200;
  await page.evaluate(() => { openDetail("c1"); });
  await page.waitForTimeout(150);
  await page.evaluate(() => closeModal());
  await page.waitForTimeout(1600);
  check(await box() === 0 && !/[?&]id=/.test(page.url()), "取得中に閉じたら、あとから戻った応答で詳細を開き直さない");
  check(!errs.length, `取得中に閉じても JSエラーなし ${errs.join(" / ")}`);

  // 2) 失敗する応答でも同じ（catch 側も消えた #detail-box に書かない）
  ctl.fail.add("c1");
  await page.evaluate(() => { openDetail("c1"); });
  await page.waitForTimeout(150);
  await page.evaluate(() => closeModal());
  await page.waitForTimeout(1600);
  check(await box() === 0 && !errs.length, `失敗した応答が閉じたあとに戻っても JSエラーなし ${errs.join(" / ")}`);
  ctl.fail.delete("c1");

  // 3) 遅いA → 速いB と切り替える → Aの応答がBの詳細を上書きしない
  ctl.delay.c2 = 1500;
  await page.evaluate(() => { openDetail("c2"); });
  await page.waitForTimeout(150);
  await page.evaluate(() => { openDetail("c3"); });
  await page.locator(".sl-detail", { hasText: "返信工業" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1800);
  const t = await page.locator("#detail-box").innerText().catch(() => "");
  check(t.includes("返信工業") && !t.includes("反応商事"), "あとから開いた企業の詳細だけが出る（古い応答で上書きしない）");
  check(/[?&]id=c3\b/.test(page.url()), `URL もあとから開いた企業のまま（${page.url()}）`);
  check(await page.evaluate(() => detail?.company?.id) === "c3", "内部の詳細データもあとから開いた企業");
  delete ctl.delay.c2;

  // 4) 面談の操作中（再取得の途中）にドロワーを閉じる → 面談パネルを開き直さない・落ちない
  await page.evaluate(() => { openDetail("c2"); });
  await page.locator(".sl-detail", { hasText: "反応商事" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.evaluate(() => openMeeting());
  await page.locator(".sl-modal h2", { hasText: "商談を予定する" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  ctl.delay.c2 = 1200;
  await page.locator("button", { hasText: "日程調整を開始" }).click();
  await page.waitForTimeout(200);
  await page.evaluate(() => closeModal());
  await page.waitForTimeout(1600);
  check(await box() === 0 && await page.locator(".sl-modal").count() === 0, "再取得の途中で閉じたら、詳細も面談パネルも開き直さない");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  delete ctl.delay.c2;

  // 5) ふつうに開けば、これまでどおり出る
  await page.evaluate(() => { openDetail("c1"); });
  await page.locator(".sl-detail", { hasText: "株式会社サンプル" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  check(await page.locator(".sl-detail", { hasText: "株式会社サンプル" }).isVisible(), "ふつうに開けば詳細が出る");
  await page.close();
}

console.log("\n=== 企業詳細からの操作は中央モーダル（2つ目の右ドロワーは出さない） ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/companies.html?id=c1`);
  await page.locator(".sl-detail", { hasText: "株式会社サンプル" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  const vp = page.viewportSize();
  const drawers = () => page.locator(".sl-drawer").count();
  const modals = () => page.locator(".sl-modal").count();
  for (const [label, title] of [["履歴を記録", "履歴を記録"], ["ステータス・NEXT", "ステータス・NEXT"],
    ["基本情報を編集", "基本情報を編集"], ["営業禁止にする", "営業禁止にする"]]) {
    await page.locator(".sl-detail button", { hasText: label }).first().click();
    await page.locator(".sl-modal h2", { hasText: title }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    const bb = await page.locator(".sl-modal").boundingBox().catch(() => null);
    const centered = bb && Math.abs(bb.x + bb.width / 2 - vp.width / 2) < 4 && Math.abs(bb.y + bb.height / 2 - vp.height / 2) < 4;
    check(await modals() === 1 && await drawers() === 0 && centered, `「${label}」は中央モーダル1つ（右ドロワーは重ねない）`);
    // 背景を押して閉じても、閉じるのはモーダルだけ
    await page.mouse.click(20, vp.height / 2);
    await page.waitForTimeout(200);
    check(await modals() === 0 && await page.locator("#detail-box").isVisible(), `「${label}」を閉じても企業詳細ドロワーは残る`);
  }

  // 保存後：モーダルを閉じ、企業詳細を取り直して背後のドロワーへ反映（ドロワーは閉じない）
  const before = calls.filter((c) => c.kind === "detail" && c.method === "GET").length;
  await page.locator(".sl-detail button", { hasText: "ステータス・NEXT" }).click();
  await page.locator(".sl-modal").waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.selectOption("#st-status", "attacked");
  await page.locator(".sl-modal button", { hasText: "保存する" }).click();
  await page.waitForFunction(() => !document.querySelector(".sl-modal"), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);
  check(calls.some((c) => c.kind === "detail" && c.method === "PATCH"), "保存した");
  check(await modals() === 0 && await page.locator("#detail-box").isVisible()
    && calls.filter((c) => c.kind === "detail" && c.method === "GET").length > before, "保存後はモーダルを閉じ、企業詳細を取り直してドロワーに反映");
  check(!(await page.locator("#detail-box").innerText()).includes("読み込み中"), "ドロワーは開き直さない（読み込み中に戻らない）");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();

  // 商談を予定する（リード）も中央モーダル
  const m = await openAs();
  await m.page.goto(`${BASE}/sales/companies.html?id=c2`);
  await m.page.locator(".sl-detail", { hasText: "反応商事" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await m.page.locator(".sl-next button", { hasText: "商談を予定する" }).click();
  await m.page.locator(".sl-modal h2", { hasText: "商談を予定する" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  check(await m.page.locator(".sl-modal").count() === 1 && await m.page.locator(".sl-drawer").count() === 0, "「商談を予定する」も中央モーダル1つ");
  const mt = await m.page.locator(".sl-modal").innerText();
  check(mt.includes("反応商事") && mt.includes("初回商談（30分）") && mt.includes("担当"), "企業名・面談種別・担当が出る");
  await m.page.locator(".sl-modal button", { hasText: "閉じる" }).click();
  check(await m.page.locator(".sl-modal").count() === 0 && await m.page.locator("#detail-box").isVisible(), "閉じても企業詳細は残る");
  await m.page.close();
}

console.log("\n=== 企業一覧：複数選択 → 画面下のバー → 中央モーダルで一括変更 ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/companies.html`);
  await page.locator("#rows tr[data-id]").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  check(await page.locator(".sl-bulkbar").count() === 0, "選ぶまではバーを出さない");
  await page.locator('#rows tr[data-id="c1"] td.sl-check input').click();
  await page.locator('#rows tr[data-id="c2"] td.sl-check input').click();
  await page.waitForTimeout(200);
  check(await page.locator("#detail-box").count() === 0, "チェックボックスを押しても企業詳細は開かない");
  check((await page.locator(".sl-bulkbar").innerText()).includes("2社選択中"), "「2社選択中」と出る");
  const vp = page.viewportSize();
  const bb = await page.locator(".sl-bulkbar").boundingBox();
  check(bb && Math.abs(bb.x + bb.width / 2 - vp.width / 2) < 4 && vp.height - (bb.y + bb.height) <= 30, "バーは画面下の中央");
  const barText = await page.locator(".sl-bulkbar").innerText();
  check(["ステータス変更", "担当変更", "その他", "選択解除"].every((t) => barText.includes(t)) && !barText.includes("削除"),
    "表に出すのは ステータス変更・担当変更・その他・選択解除 だけ（削除は「その他」の中）");
  check(await page.locator('#rows tr[data-id="c1"]').evaluate((e) => e.classList.contains("sel")), "選んだ行は薄く色が付く");

  await page.locator(".sl-bulkbar button", { hasText: "ステータス変更" }).click();
  await page.locator(".sl-modal h2", { hasText: "2社のステータスを変更します" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  check(await page.locator(".sl-modal").count() === 1 && await page.locator(".sl-drawer").count() === 0, "ステータス変更は中央モーダル");
  await page.selectOption("#bk-status", "excluded");
  await page.locator(".sl-modal button", { hasText: "2社を変更する" }).click();
  await page.waitForFunction(() => !document.querySelector(".sl-modal"), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);
  const sc = calls.find((c) => c.kind === "bulk-change_status");
  check(sc && sc.body.status === "excluded" && JSON.stringify([...sc.body.ids].sort()) === JSON.stringify(["c1", "c2"]), "2社をまとめて1回で変更");
  const t = await page.locator("#rows").innerText();
  check((t.match(/対象外/g) || []).length === 2, "2社とも更新される");
  check(await page.locator(".sl-bulkbar").count() === 0 && await page.locator("#rows input:checked").count() === 0, "選択が解除され、バーが消える");

  // 担当変更
  await page.locator('#rows tr[data-id="c3"] td.sl-check input').click();
  await page.locator(".sl-bulkbar button", { hasText: "担当変更" }).click();
  await page.locator(".sl-modal h2", { hasText: "1社の担当を変更します" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.locator(".sl-modal button", { hasText: "1社を変更する" }).click();
  await page.waitForTimeout(500);
  check(calls.some((c) => c.kind === "bulk-change_owner" && c.body.ids.join() === "c3" && c.body.ownerId === "emp-s1"), "担当もまとめて変更");

  // 「その他」メニュー
  await page.locator('#rows tr[data-id="c1"] td.sl-check input').click();
  await page.locator(".sl-bulkbar button", { hasText: "その他" }).click();
  const menu = await page.locator("#bulk-menu").innerText();
  check(["提案サービス変更", "キャンペーン変更", "営業禁止にする", "削除"].every((x) => menu.includes(x))
    && menu.trim().endsWith("削除"), "その他：提案サービス・キャンペーン・営業禁止・削除（削除はいちばん下）");
  await page.locator("#bulk-menu button", { hasText: "キャンペーン変更" }).click();
  await page.locator("#bk-campaign:not([disabled])").waitFor({ timeout: 15000 }).catch(() => {});
  await page.selectOption("#bk-campaign", "cp1");
  await page.locator(".sl-modal button", { hasText: "1社を変更する" }).click();
  await page.waitForTimeout(500);
  check(calls.some((c) => c.kind === "bulk-change_campaign" && c.body.campaignId === "cp1"), "キャンペーンもまとめて変更");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 全選択は、いま表示している企業だけ ===");
{
  const { page, calls } = await openAs();
  await page.goto(`${BASE}/sales/companies.html`);
  await page.locator("#rows tr[data-id]").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.fill("#f-q", "hannou");
  await page.waitForFunction(() => document.querySelectorAll("#rows tr[data-id]").length === 1);
  check(await page.locator("#rows tr[data-id]").count() === 1, "絞り込むと1社（サーバーで検索）");
  await page.locator("#sel-all").click();
  await page.waitForTimeout(200);
  check((await page.locator(".sl-bulkbar").innerText()).includes("1社選択中"), "全選択で選ばれるのは表示中の1社だけ");
  await page.fill("#f-q", "");
  await page.waitForFunction(() => document.querySelectorAll("#rows tr[data-id]").length === 3);
  check(await page.locator("#rows input:checked").count() === 1 && await page.locator('#rows tr[data-id="c2"] td.sl-check input').isChecked(),
    "非表示だった企業は選ばれていない");
  await page.locator(".sl-bulkbar button", { hasText: "担当変更" }).click();
  await page.locator(".sl-modal button", { hasText: "1社を変更する" }).click();
  await page.waitForTimeout(500);
  check(calls.find((c) => c.kind === "bulk-change_owner")?.body.ids.join() === "c2", "一括操作の対象も表示中に選んだ企業だけ");
  // 絞り込みで見えなくなった企業は、選択から外す（見えない企業に一括操作が及ばない）
  await page.locator('#rows tr[data-id="c2"] td.sl-check input').click();
  await page.fill("#f-q", "サンプル");
  await page.waitForFunction(() => document.querySelectorAll("#rows tr[data-id]").length === 1);
  check(await page.locator(".sl-bulkbar").count() === 0, "絞り込みで見えなくなった企業は選択から外れる");
  await page.close();
}

console.log("\n=== 削除：確認モーダル → 履歴の無い企業だけ消す ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/companies.html`);
  await page.locator("#rows tr[data-id]").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.locator('#rows tr[data-id="c1"] td.sl-check input').click();
  await page.locator('#rows tr[data-id="c2"] td.sl-check input').click();
  await page.locator(".sl-bulkbar button", { hasText: "その他" }).click();
  await page.locator("#bulk-menu button.danger", { hasText: "削除" }).click();
  await page.locator(".sl-modal", { hasText: "削除する企業" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  const txt = await page.locator(".sl-modal").innerText();
  check(txt.includes("選択した2社を削除します"), "すぐには消さず、確認モーダルを出す");
  check(calls.some((c) => c.kind === "bulk-delete-dry") && !calls.some((c) => c.kind === "bulk-delete"), "先にサーバで関連履歴を確かめる（まだ消さない）");
  check(/削除できない企業：1社/.test(txt) && txt.includes("反応商事") && txt.includes("アタック履歴あり"), "履歴のある企業は削除できない（理由つき）");
  check(txt.includes("対象外"), "消せない企業は「対象外」などのステータスを案内");
  check(await page.locator(".sl-modal button.btn-danger", { hasText: "1社を削除する" }).count() === 1, "削除ボタンは赤で、消せる企業の数だけ");
  await page.locator(".sl-modal button", { hasText: "1社を削除する" }).click();
  await page.waitForTimeout(600);
  const del = calls.find((c) => c.kind === "bulk-delete");
  check(del && del.body.ids.join() === "c1", "消すのは履歴の無い企業だけ");
  check(await page.locator('#rows tr[data-id="c1"]').count() === 0 && await page.locator('#rows tr[data-id="c2"]').count() === 1,
    "一覧から消え、履歴のある企業は残る");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 送信チャネル：Instagram・送信元つきで送信完了 ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/companies.html?attack=c1`);
  await page.locator("#at-body").waitFor();
  await page.locator("#at-channel").selectOption("instagram");
  await page.waitForTimeout(500);
  const preps = calls.filter((c) => c.kind === "prepare");
  check(preps.at(-1)?.body.channel === "instagram", "チャネルを変えると、そのチャネルで専用URLを準備し直す（同じチャネルの30日チェック）");
  check((await page.locator(".atk").innerText()).includes("Instagramで貼り付け"), "手順の案内がチャネルに合わせて変わる");
  await page.locator("button", { hasText: "送信完了" }).click();
  await page.locator(".sl-modal").waitFor();
  check(await page.locator('.sl-modal input[name="sd-channel"][value="instagram"]').isChecked(), "選んだチャネルがモーダルで選ばれている");
  await page.locator("#sd-from").fill("@eight_xxx");
  await page.locator(".sl-modal button", { hasText: "記録する" }).click();
  await page.waitForTimeout(800);
  const sent = calls.find((c) => c.kind === "act");
  check(sent && sent.body.channel === "instagram" && sent.body.sendFrom === "@eight_xxx", "Instagram・送信元を記録する");
  // 次に開いたときは、同じチャネルの送信元を覚えている（この端末だけ）
  await page.goto(`${BASE}/sales/companies.html?attack=c1`);
  await page.locator("#at-body").waitFor();
  await page.locator("#at-channel").selectOption("instagram");
  await page.waitForTimeout(400);
  await page.locator("button", { hasText: "送信完了" }).click();
  await page.locator(".sl-modal").waitFor();
  check((await page.locator("#sd-from").inputValue()) === "@eight_xxx", "送信元は前回の値が入る");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 別チャネルで直近に送信済み：警告 → 「別チャネルで送る」で進める ===");
{
  const threeDays = new Date(Date.now() - 3 * 86400000).toISOString();
  const recentOther = { sentAt: threeDays, employeeName: "営業 二郎", service: "AI / DX", days: 30,
    channel: "instagram", channelLabel: "Instagram" };
  const { page, calls, errs } = await openAs({ recentOther });
  await page.goto(`${BASE}/sales/companies.html?attack=c1`);
  await page.locator("#at-recent-other").waitFor();
  check((await page.locator("#at-recent-other").innerText()).includes("3日前にInstagramから送信済みです"),
    "「3日前にInstagramから送信済みです」と会社単位の直近接触を出す");
  check(!(await page.locator("#at-body").count()), "確認するまでは営業文を出さない（無自覚に送らせない）");
  check(!(await page.locator('#at-other-channel option[value="instagram"]').count()), "直近に送ったチャネルは候補に出さない");
  await page.locator("#at-other-channel").selectOption("x");
  await page.locator("button", { hasText: "別チャネルで送る" }).click();
  await page.locator("#at-body").waitFor();
  const prep = calls.filter((c) => c.kind === "prepare").at(-1);
  check(prep?.body.channel === "x" && prep?.body.acknowledgeRecent === true, "X・確認済みで専用URLを準備する");
  check((await page.locator("#at-recent-banner").innerText()).includes("別チャネル（X）で送ります"), "営業文画面に確認の帯が残る");
  await page.locator("button", { hasText: "送信完了" }).click();
  await page.locator(".sl-modal").waitFor();
  await page.locator(".sl-modal button", { hasText: "記録する" }).click();
  await page.waitForTimeout(800);
  const sent = calls.find((c) => c.kind === "act");
  check(sent?.body.channel === "x" && sent?.body.acknowledgeRecent === true, "送信完了にも確認済みを付けて送る");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 送信できなかった：理由を選んで記録 ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/companies.html?attack=c1`);
  await page.locator("#at-body").waitFor();
  await page.locator("button", { hasText: "送信できなかった" }).click();
  await page.locator(".sl-modal").waitFor();
  check((await page.locator(".sl-modal").innerText()).includes("問い合わせフォームがない"), "理由の候補が出る");
  await page.locator(".sl-modal button", { hasText: "記録する" }).click();
  check((await page.locator("#fl-msg").innerText()).includes("理由を選んでください"), "理由なしでは記録しない");
  await page.locator('.sl-modal input[name="fl-reason"][value="other"]').check();
  await page.locator(".sl-modal button", { hasText: "記録する" }).click();
  check((await page.locator("#fl-msg").innerText()).includes("メモ"), "「その他」はメモ必須");
  check(!calls.some((c) => c.kind === "act"), "ここまでは送らない");
  await page.locator('.sl-modal input[name="fl-reason"][value="no_form"]').check();
  await page.locator(".sl-modal button", { hasText: "記録する" }).click();
  await page.waitForTimeout(800);
  const f = calls.find((c) => c.kind === "act");
  check(f && f.body.action === "failed" && f.body.reason === "no_form" && f.body.channel === "form", "送信できなかった（理由・チャネル）を記録した");
  check(!(await page.locator(".atk").count()), "記録するとアタック画面を閉じる");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 非表示：一括で非表示 → 一覧から消える → 非表示フィルター → 再表示 ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/companies.html`);
  await page.locator("#rows tr[data-id]").first().waitFor();
  const heads = await page.locator(".sl-table thead th").allInnerTexts();
  const H = heads.map((h) => h.replace(/unfold_more|arrow_upward|arrow_downward/gi, "").trim());
  check(JSON.stringify(H) === JSON.stringify(["", "企業", "業種", "地域", "提案サービス", "キャンペーン", "状態", "最終アタック", "連絡手段", "クリック", "NEXT", "担当"]),
    `一覧の列（業種・地域は独立した列）：${H.join(" ")}`);
  await page.locator('#rows tr[data-id="c1"] td.sl-check input').check();
  await page.locator("#bulk-more").click();
  await page.locator("#bulk-menu button", { hasText: "非表示にする" }).click();
  await page.locator(".sl-modal").waitFor();
  await page.locator("#bk-go").click();
  check((await page.locator("#bk-msg").innerText()).includes("理由"), "理由なしでは非表示にしない");
  await page.locator('.sl-modal input[name="bk-hide"][value="link_broken"]').check();
  await page.locator("#bk-go").click();
  await page.waitForFunction(() => !document.querySelector('#rows tr[data-id="c1"]'));
  const h = calls.find((c) => c.kind === "bulk-hide");
  check(h && h.body.reason === "link_broken" && h.body.ids.join() === "c1", "一括APIで非表示（理由つき）");
  check(!(await page.locator('#rows tr[data-id="c1"]').count()), "通常の一覧から消える");

  await page.locator("#f-visibility").selectOption("hidden");
  await page.locator('#rows tr[data-id="c1"]').waitFor();
  check(calls.some((c) => c.kind === "list" && c.visibility === "hidden"), "「非表示」で取り直す");
  check((await page.locator('#rows tr[data-id="c1"]').innerText()).includes("非表示：リンク切れ"), "非表示の理由が状態に出る");
  await page.locator('#rows tr[data-id="c1"] td.sl-check input').check();
  await page.locator("#bulk-more").click();
  await page.locator("#bulk-menu button", { hasText: "再表示する" }).click();
  await page.locator("#bk-go").click();
  await page.waitForFunction(() => !document.querySelector('#rows tr[data-id="c1"]'));
  check(calls.some((c) => c.kind === "bulk-unhide"), "再表示した");
  await page.locator("#f-visibility").selectOption("shown");
  await page.locator('#rows tr[data-id="c1"]').waitFor();
  check(true, "表示中に戻っている");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 返信・やり取りを記録：Instagramで返信 → メールへ ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/companies.html?id=c3`);
  await page.locator(".sl-detail #contact-status").waitFor();
  check((await page.locator("#contact-status").innerText()).includes("現在の連絡手段"), "企業詳細の上部に「現在の連絡状況」");
  await page.locator(".sl-detail button", { hasText: "返信・やり取りを記録" }).first().click();
  await page.locator(".sl-modal").waitFor();
  check(!(await page.locator(".sl-drawer").count()), "2つ目の右ドロワーではなく中央モーダル");
  // 返信あり（c3）の会社は「こちらから連絡」が初期値。返信に切り替える
  await page.locator('.sl-modal input[name="ct-kind"][value="reply"]').check();
  await page.locator(".sl-modal button", { hasText: "記録する" }).click();
  check((await page.locator("#ct-msg").innerText()).includes("どこから返信"), "返信元は必須");
  await page.locator('.sl-modal input[name="ct-reply"][value="instagram"]').check();
  check((await page.locator("#ct-channel").inputValue()) === "instagram", "返信元と同じチャネルを連絡手段に入れておく");
  await page.locator("#ct-channel").selectOption("email");
  await page.locator("#ct-c-email").fill("tanaka@example.co.jp");
  await page.locator("#ct-note").fill("詳細資料はメールで送付");
  await page.locator("#ct-next").fill("資料送付");
  await page.locator("#ct-next-on").fill("2026-10-01");
  await page.locator(".sl-modal button", { hasText: "記録する" }).click();
  await page.waitForFunction(() => !document.querySelector(".sl-modal"));
  const r = calls.find((c) => c.kind === "contact");
  check(r && r.body.replied === true && r.body.replyChannel === "instagram" && r.body.contactChannel === "email",
    "返信元・いまの連絡手段を送る");
  check(r && r.body.contacts?.email === "tanaka@example.co.jp" && r.body.note.includes("資料"), "連絡先・メモを送る");
  check(r && r.body.nextAction === "資料送付" && r.body.nextActionOn === "2026-10-01", "NEXT も一緒に送る");
  await page.waitForFunction(() => (document.querySelector("#contact-status")?.innerText || "").includes("tanaka@example.co.jp"));
  check((await page.locator("#contact-status").innerText()).includes("メール"), "現在の連絡手段がメールになる");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 企業一覧：サーバー側ページング（100件ずつ）・並べ替え・URLの状態 ===");
{
  const { page, calls, errs, ctlList } = await openAs({ many: 250 });   // 3 + 250 = 253社
  await page.goto(`${BASE}/sales/companies.html`);
  await page.locator("#rows tr[data-id]").first().waitFor();
  const first = calls.find((c) => c.kind === "list");
  check(first?.params.page === "1" && first?.params.facets === "1", "1ページ目を頼む（絞り込みの件数もサーバーで数える）");
  check(await page.locator("#rows tr[data-id]").count() === 100, "1ページに100社");
  check((await page.locator("#range").innerText()).trim() === "1–100 / 253件", `件数の表示（${await page.locator("#range").innerText()}）`);
  check((await page.locator("#pager").innerText()).includes("次へ"), "ページャーが出る");
  check((await page.locator("#f-industry").innerText()).includes("士業（"), "業種の候補は件数つき（サーバーの集計）");

  // ページ移動：押した瞬間に反応（薄く・読み込み中）→ 次の100件だけ取る
  ctlList.delay = 600;   // サーバーが遅いときでも、押した瞬間に反応が出るか
  await page.locator("#pager button", { hasText: "次へ" }).click();
  const reacted = await page.evaluate(() => document.getElementById("rows").classList.contains("loading")
    && Boolean(document.getElementById("loading")) && [...document.querySelectorAll("#pager button")].every((b) => b.disabled));
  check(reacted, "押した瞬間に反応する（一覧を薄く・読み込み中・ページャーは押せない）");
  ctlList.delay = 0;
  await page.waitForFunction(() => (document.getElementById("range")?.innerText || "").startsWith("101–200"));
  check(calls.filter((c) => c.kind === "list").at(-1).params.page === "2", "2ページ目の100件だけを取り直す");
  check(/[?&]page=2/.test(page.url()), "URL にページを書く");
  check(await page.locator("#pager button.on").innerText() === "2", "いまのページが分かる");

  // 並べ替え：見出しを押す → 昇順 → 降順 → 解除。変えたら1ページ目へ
  await page.locator('th[data-sort="name"]').click();
  await page.waitForFunction(() => /sort=name/.test(location.search));
  const s1 = calls.filter((c) => c.kind === "list").at(-1).params;
  check(s1.sort === "name" && s1.order === "asc" && s1.page === "1", "企業名で昇順・1ページ目へ戻る（サーバーで並べる）");
  check(await page.locator('th[data-sort="name"]').getAttribute("aria-sort") === "ascending"
    && await page.locator('th[data-sort="name"].on').count() === 1, "並べ替え中の列が分かる（矢印・色・太さ）");
  await page.locator('th[data-sort="name"]').click();
  await page.waitForFunction(() => /order=desc/.test(location.search));
  await page.waitForFunction(() => document.querySelector("#rows tr[data-id] .sl-nm")?.textContent === "返信工業");
  check(true, "降順で並び直す");
  await page.locator('th[data-sort="name"]').click();
  await page.waitForFunction(() => !/sort=/.test(location.search));
  check(await page.locator("th.sort.on").count() === 0, "3回目で並べ替えを解除");

  // 担当・NEXT もサーバーで並べる（担当者名順・実効NEXT順。db/098）
  for (const key of ["owner", "next"]) {
    await page.locator(`th[data-sort="${key}"]`).click();
    await page.waitForFunction((k) => new URLSearchParams(location.search).get("sort") === k, key);
    const p = calls.filter((c) => c.kind === "list").at(-1).params;
    check(p.sort === key && p.order === "asc" && p.page === "1", `${key} の並べ替えはサーバーへ（sort=${key}）`);
  }
  check((await page.locator('th[data-sort="next"]').getAttribute("title")).includes("要フォロー"), "NEXT の並び方を見出しで説明");
  await page.locator('th[data-sort="next"]').click();
  await page.locator('th[data-sort="next"]').click();
  await page.waitForFunction(() => !/sort=/.test(location.search));

  // 絞り込み → 3ページ目 → 企業詳細を開いて閉じる → 同じページ・条件のまま
  await page.locator("#f-region").selectOption("東京都");
  await page.waitForFunction(() => /region=/.test(location.search));
  const f = calls.filter((c) => c.kind === "list").at(-1).params;
  check(f.region === "東京都" && f.page === "1", "絞り込みはサーバーへ渡し、1ページ目へ戻る");
  await page.locator('th[data-sort="industry"]').click();
  await page.waitForFunction(() => /sort=industry/.test(location.search));
  await page.locator("#f-region").selectOption("");
  await page.waitForFunction(() => !/region=/.test(location.search));
  await page.locator("#pager button", { hasText: "3" }).first().click();
  await page.waitForFunction(() => (document.getElementById("range")?.innerText || "").startsWith("201–"));
  const listUrl = page.url();
  await page.locator("#rows tr[data-id]").first().click();
  await page.locator(".sl-detail #contact-status, .sl-detail .sl-next").first().waitFor();
  check(/[?&]id=/.test(page.url()) && /page=3/.test(page.url()) && /sort=industry/.test(page.url()),
    "企業詳細を開いても一覧の状態は URL に残る");
  await page.locator(".sl-detail button", { hasText: "閉じる" }).first().click();
  check(page.url() === listUrl, "閉じると元の URL（3ページ目・並べ替え）に戻る");
  check((await page.locator("#range").innerText()).startsWith("201–"), "元のページのまま");

  // ブラウザの戻る：1つ前の状態（2ページ目ではなく、直前の操作）へ
  await page.goBack();
  await page.waitForFunction(() => !/page=3/.test(location.search));
  check(!/page=3/.test(page.url()), "戻るで1つ前の一覧の状態に戻る");
  // URL を直接開いても復元する
  await page.goto(`${BASE}/sales/companies.html?page=2&industry=士業&sort=name&order=desc`);
  await page.locator("#rows tr[data-id]").first().waitFor();
  const r = calls.filter((c) => c.kind === "list").at(-1).params;
  check(r.page === "2" && r.industry === "士業" && r.sort === "name" && r.order === "desc", "URL の状態でそのまま取る");
  check(await page.locator("#f-industry").inputValue() === "士業", "絞り込みの欄にも反映");

  // 全選択はこのページの企業だけ
  await page.locator("#sel-all").click();
  const n = await page.locator("#rows tr[data-id]").count();
  check((await page.locator(".sl-bulkbar").innerText()).includes(`${n}社選択中`), `全選択はこのページの${n}社だけ`);
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== CSV：検索結果すべて／チェックした企業だけ（サーバーで作る） ===");
{
  const { page, calls, errs } = await openAs({ many: 120 });
  await page.goto(`${BASE}/sales/companies.html?industry=士業&sort=name&order=asc`);
  await page.locator("#rows tr[data-id]").first().waitFor();
  await page.locator("#btn-download").click();
  await page.locator(".sl-modal").waitFor();
  check(await page.locator('input[name="dl-target"][value="selected"]').isDisabled(), "何も選んでいなければ「選択中」は選べない");
  check((await page.locator(".sl-modal").innerText()).includes("いまの検索・絞り込み結果すべて（60社）"), "検索結果すべて（件数つき）");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator("#dl-go").click()]);
  const ex = calls.find((c) => c.kind === "export");
  check(ex?.method === "GET" && ex.params.industry === "士業" && ex.params.sort === "name" && !ex.params.page,
    "いまの条件をそのままサーバーへ渡す（ページは渡さない＝全件）");
  check(dl.suggestedFilename() === "sales_companies_2026-09-29.csv", `ファイル名（${dl.suggestedFilename()}）`);
  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(await dl.path());
  check(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, "BOM つきのまま保存");

  await page.locator("#rows tr[data-id] td.sl-check input").nth(0).check();
  await page.locator("#rows tr[data-id] td.sl-check input").nth(1).check();
  await page.locator("#btn-download").click();
  await page.locator(".sl-modal").waitFor();
  check(await page.locator('input[name="dl-target"][value="selected"]').isChecked(), "選択があれば「選択中 2社」を先に選ぶ");
  check((await page.locator(".sl-modal").innerText()).includes("選択中 2社"), "選択中の件数");
  await Promise.all([page.waitForEvent("download"), page.locator("#dl-go").click()]);
  const ex2 = calls.filter((c) => c.kind === "export").at(-1);
  check(ex2?.method === "POST" && ex2.body.ids.length === 2 && ex2.body.sort === "name", "チェックした企業だけ（ID を POST。並び順つき）");
  // 画面下のバーからも
  await Promise.all([page.waitForEvent("download"), page.locator("#bulk-csv").click()]);
  check(calls.filter((c) => c.kind === "export").length === 3, "画面下のバーの CSV からも選択中をダウンロード");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 共通マスター：企業追加は選ぶだけ（業種・都道府県・提案サービス）。件数はいまの条件に連動 ===");
{
  const { page, calls, errs } = await openAs({ many: 12 });
  await page.goto(`${BASE}/sales/companies.html`);
  await page.locator("#rows tr[data-id]").first().waitFor();
  const optTexts = (sel) => page.locator(`${sel} option`).allInnerTexts();
  // 一覧の絞り込み：業種・地域・商材はマスター（件数0も出す。自由データから作らない）
  const ind = await optTexts("#f-industry");
  check(ind.length === 7 && ind[1].startsWith("製造（") && ind.some((t) => t === "不動産（0）"), `業種はマスターの6つ＋すべて（${ind.join("/")}）`);
  const reg = await optTexts("#f-region");
  check(reg.length === 49 && reg[1].startsWith("北海道") && reg[47].startsWith("沖縄県") && reg[48].startsWith("未設定"),
    `地域は47都道府県＋未設定（${reg.length - 1}）`);
  check((await optTexts("#f-service")).length === 8, "商材はマスターの7つ");
  const tokyo0 = reg.find((t) => t.startsWith("東京都"));
  check(tokyo0 === "東京都（7）", `東京都の件数（${tokyo0}）`);
  // 業種を変えると地域の件数も変わる。総件数とも一致
  await page.locator("#f-industry").selectOption("製造");
  await page.waitForFunction(() => /industry=/.test(location.search) && !document.getElementById("loading"));
  const tokyo1 = (await optTexts("#f-region")).find((t) => t.startsWith("東京都"));
  check(tokyo1 === "東京都（5）", `業種＝製造にすると東京都の件数が変わる（${tokyo0} → ${tokyo1}）`);
  const mfg = (await optTexts("#f-industry")).find((t) => t.startsWith("製造"));
  const range = (await page.locator("#range").innerText()).trim();
  check(mfg === "製造（9）" && range === "1–9 / 9件", `絞り込みの件数と一覧の件数が一致（${mfg}・${range}）`);
  // 並べ替えでは件数は変わらない
  const before = await optTexts("#f-region");
  await page.locator('th[data-sort="name"]').click();
  await page.waitForFunction(() => /sort=name/.test(location.search) && !document.getElementById("loading"));
  check(JSON.stringify(await optTexts("#f-region")) === JSON.stringify(before), "並べ替えても件数は同じ");
  const last = calls.filter((c) => c.kind === "list").at(-1).params;
  check(last.facets === "1" && last.industry === "製造", "件数はいまの条件でサーバーに数えさせる");
  // 検索語でも件数が変わる
  await page.fill("#f-q", "企業001");
  await page.locator("#f-q").dispatchEvent("input");
  await page.waitForFunction(() => /q=/.test(location.search) && !document.getElementById("loading"));
  await page.waitForTimeout(300);
  const mfgQ = (await optTexts("#f-industry")).find((t) => t.startsWith("製造"));
  check(mfgQ === "製造（1）", `検索語も件数に効く（${mfgQ}）`);

  // 企業追加：業種・地域・提案サービスはマスターの select（自由入力なし）
  await page.goto(`${BASE}/sales/companies.html?new=1`);
  await page.locator("#q-url").waitFor();
  check(await page.locator("#q-region").evaluate((e) => e.tagName) === "SELECT"
    && await page.locator("#q-industry").evaluate((e) => e.tagName) === "SELECT", "業種・地域は select");
  check((await page.locator("#q-region option").count()) === 48, "地域は47都道府県（＋未設定）");
  check(!(await page.locator("#q-more input[list]").count()), "datalist の自由入力は残っていない");
  await page.fill("#q-url", "https://kagoshima-seizo.jp/");
  await page.locator("#q-url").dispatchEvent("change");
  await page.waitForTimeout(600);
  await page.locator("#q-more summary").click();
  await page.selectOption("#q-industry", "製造");
  await page.selectOption("#q-region", "鹿児島県");
  await page.locator("button", { hasText: "追加だけする" }).click();
  await page.waitForFunction(() => !document.querySelector(".sl-drawer #q-url"));
  const made = calls.filter((c) => c.kind === "create").at(-1);
  check(made?.body.region === "鹿児島県" && made.body.industry === "製造", "「鹿児島県」を選んで登録");
  await page.waitForFunction(() => [...document.querySelectorAll("#f-region option")].some((o) => o.textContent === "鹿児島県（1）"));
  check(true, "登録後、地域の絞り込みに鹿児島県（1）が出る");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 旧データ（マスター外の業種・市区町村つきの地域）：一覧・絞り込みには出す／新規では選べない ===");
{
  const LEGACY = "イベント企画・制作・運営";
  const { page, calls, errs } = await openAs({ extra: [
    { id: "old1", name: "株式会社イベントワークス", domain: "event-works.jp", industry: LEGACY, region: "鹿児島県鹿屋市", service: "旧商材A" },
    { id: "k2", name: "鹿児島製作所", domain: "kago-seisaku.jp", industry: "製造", region: "鹿児島県" },
  ] });
  await page.goto(`${BASE}/sales/companies.html`);
  await page.locator("#rows tr[data-id]").first().waitFor();
  const optTexts = (sel) => page.locator(`${sel} option`).allInnerTexts();
  const row = page.locator('#rows tr[data-id="old1"]');
  check(await row.count() === 1 && (await row.innerText()).includes(LEGACY), "旧業種の企業が一覧に出る");
  check((await row.innerText()).includes("鹿児島県") && !(await row.innerText()).includes("鹿屋市"), "地域は都道府県だけ表示（鹿児島県鹿屋市 → 鹿児島県）");
  const ind = await optTexts("#f-industry");
  check(ind.includes(`${LEGACY}（1・旧データ）`), `業種の絞り込みに旧データが件数つきで出る（${ind.join("/")}）`);
  check(ind.indexOf(`${LEGACY}（1・旧データ）`) > ind.indexOf("その他（0）"), "旧データはマスターの後ろ");
  check((await optTexts("#f-service")).includes("旧商材A（1・旧データ）"), "商材も同じ（旧データを件数つきで）");
  const reg = await optTexts("#f-region");
  check(reg.length === 49 && !reg.some((t) => t.includes("鹿屋市")) && reg[48].startsWith("未設定"), "地域は47都道府県＋未設定だけ（旧値は足さない）");
  check(reg.includes("鹿児島県（2）"), `鹿児島県鹿屋市は鹿児島県に合算（${reg.find((t) => t.startsWith("鹿児島県"))}）`);

  await page.locator("#f-industry").selectOption(LEGACY);
  await page.waitForFunction(() => /industry=/.test(location.search) && !document.getElementById("loading"));
  const ids = await page.locator("#rows tr[data-id]").evaluateAll((trs) => trs.map((t) => t.dataset.id));
  check(ids.length === 1 && ids[0] === "old1", `選ぶとその企業だけに絞れる（${ids.join(",")}）`);
  check(calls.filter((c) => c.kind === "list").at(-1).params.industry === LEGACY, "旧データの値のままサーバーへ渡す");
  check((await page.locator("#f-industry").inputValue()) === LEGACY
    && (await optTexts("#f-industry")).includes(`${LEGACY}（1・旧データ）`), "選んだ後も旧データの表示のまま");
  check((await page.locator("#range").innerText()).trim() === "1–1 / 1件", "件数も一致");

  // 新規追加では旧値を選べない（業種・地域・提案サービスはマスターだけ）
  await page.goto(`${BASE}/sales/companies.html?new=1`);
  await page.locator("#q-url").waitFor();
  const qi = await page.locator("#q-industry option").evaluateAll((os) => os.map((o) => o.value));
  const qs = await page.locator("#q-service option").evaluateAll((os) => os.map((o) => o.value));
  const qr = await page.locator("#q-region option").evaluateAll((os) => os.map((o) => o.value));
  check(!qi.includes(LEGACY) && qi.length === 7, `新規の業種に旧データは出ない（${qi.filter(Boolean).join("/")}）`);
  check(!qs.includes("旧商材A") && qs.length === 7, "新規の提案サービスに旧データは出ない");
  check(!qr.some((v) => v.includes("鹿屋市")) && qr.length === 48, "新規の地域は47都道府県だけ");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 追加要件：新規登録（業種・提案サービス・複数メール・地域未設定）→ 一覧・絞り込み・キャンペーン列・分類の管理 ===");
{
  const { page, calls, errs } = await openAs({ many: 6, extra: [
    { id: "cp-a", name: "キャンペーン商事", domain: "camp.jp", campaignId: "cp1", campaignName: "秋の製造業" },
  ] });
  // 1〜5：企業新規登録（業種・提案サービス・複数メール・地域は未設定のまま）
  await page.goto(`${BASE}/sales/companies.html?new=1`);
  await page.locator("#q-url").waitFor();
  check((await page.locator(".sl-drawer").innerText()).includes("提案サービス"), "「提案サービス」の表記");
  await page.fill("#q-url", "https://mail-seizo.jp/");
  await page.fill("#q-name", "メール製造株式会社");
  await page.selectOption("#q-service", "PCレンタル");
  await page.locator("#q-more summary").click();
  check(!(await page.locator("#q-size").count()) && await page.locator("#q-emails").isVisible(), "企業規模ではなくメールアドレスの欄");
  await page.selectOption("#q-industry", "製造");
  await page.fill("#q-emails", "Info@Mail-Seizo.jp, sales@mail-seizo.jp, info@mail-seizo.jp");
  check(await page.locator("#q-region").inputValue() === "", "地域は未設定のまま");
  await page.locator("button", { hasText: "追加だけする" }).click();
  await page.waitForFunction(() => !document.querySelector(".sl-drawer #q-url"));
  const made = calls.filter((c) => c.kind === "create").at(-1)?.body;
  check(made?.industry === "製造" && made.service === "PCレンタル" && made.region === null
    && made.emails === "Info@Mail-Seizo.jp, sales@mail-seizo.jp, info@mail-seizo.jp", "業種・提案サービス・メール（入力のまま）・地域なしで送る");

  // 6：一覧に出る（地域は「未設定」）。追加後に開く企業詳細は閉じておく
  const row = page.locator('#rows tr[data-id="c-new"]');
  await row.waitFor();
  await page.evaluate(() => closeModal());
  check((await row.innerText()).includes("未設定"), "地域が無い企業は一覧で「未設定」");
  // 10：キャンペーン列
  check((await page.locator('#rows tr[data-id="cp-a"]').innerText()).includes("秋の製造業"), "キャンペーン列に名前");
  // 7：地域「未設定」で絞る（件数つき）
  const reg = await page.locator("#f-region option").allInnerTexts();
  check(reg.at(-1) === "未設定（1）", `地域の最後に「未設定（1）」（${reg.at(-1)}）`);
  const tokyo = reg.find((t) => t.startsWith("東京都"));
  const total0 = Number((await page.locator("#count").innerText()).replace(/\D/g, ""));
  const sumRegion = reg.slice(1).reduce((a, t) => a + Number((t.match(/（(\d+)/) || [0, 0])[1]), 0);
  check(sumRegion === total0, `47都道府県＋未設定の件数の合計＝総件数（${sumRegion}／${total0}・${tokyo}）`);
  await page.locator("#f-region").selectOption("none");
  await page.waitForFunction(() => /region=none/.test(location.search) && !document.getElementById("loading"));
  const ids = () => page.locator("#rows tr[data-id]").evaluateAll((trs) => trs.map((t) => t.dataset.id));
  check(JSON.stringify(await ids()) === JSON.stringify(["c-new"]), "未設定で絞るとその企業だけ");
  // 8・9：業種・提案サービスで絞る
  await page.locator("#f-region").selectOption("");
  await page.locator("#f-service").selectOption("PCレンタル");
  await page.waitForFunction(() => /service=/.test(location.search) && !document.getElementById("loading"));
  check((await ids()).includes("c-new") && (await ids()).length === 1, "提案サービスで絞れる");
  check((await page.locator("#f-service option").first().innerText()) === "提案サービス：すべて", "フィルタも「提案サービス」");
  await page.locator("#f-service").selectOption("");
  await page.locator("#f-industry").selectOption("製造");
  await page.waitForFunction(() => /industry=/.test(location.search) && !/service=/.test(location.search) && !document.getElementById("loading"));
  check((await ids()).includes("c-new"), "業種で絞れる");

  // 企業詳細：メールアドレス（複数）
  await page.locator('#rows tr[data-id="c-new"]').click();
  await page.locator(".sl-detail").waitFor();
  await page.waitForFunction(() => (document.querySelector(".sl-detail")?.innerText || "").includes("メールアドレス"));
  const dtl = await page.locator(".sl-detail").innerText();
  check(dtl.includes("info@mail-seizo.jp") && dtl.includes("sales@mail-seizo.jp") && !dtl.includes("企業規模"),
    "企業詳細にメールアドレス（小文字・重複なし）。企業規模は出さない");
  await page.locator(".sl-detail button", { hasText: "閉じる" }).first().click();

  // 分類の管理：追加 → 新規登録で選べる。非表示 → 選べない
  await page.locator("button", { hasText: "分類の管理" }).click();
  await page.locator("#mo-body .sl-table").first().waitFor();
  await page.fill("#mo-new-service", "Web広告");
  await page.locator(".mo-add button").nth(1).click();
  await page.waitForFunction(() => (document.getElementById("mo-body")?.innerText || "").includes("Web広告"));
  check(calls.some((c) => c.kind === "masters-POST" && c.body.kind === "service" && c.body.label === "Web広告"), "提案サービスを追加");
  await page.locator('#mo-body tr', { hasText: "ENGER" }).locator("button", { hasText: "非表示" }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("#mo-body tr")].some((t) => t.innerText.includes("ENGER") && t.innerText.includes("再表示")));
  check(calls.some((c) => c.kind === "masters-PATCH" && c.body.archived === true), "非表示にする（物理削除しない）");
  await page.locator('#mo-body tr', { hasText: "不動産" }).locator("button", { hasText: "名前を変更" }).click();
  await page.fill("#mo-edit", "不動産・建設");
  await page.locator("#mo-body button", { hasText: "保存" }).click();
  await page.waitForFunction(() => (document.getElementById("mo-body")?.innerText || "").includes("不動産・建設"));
  check(calls.some((c) => c.kind === "masters-PATCH" && c.body.label === "不動産・建設"), "名前を変更");
  await page.locator(".sl-modal-foot button", { hasText: "閉じる" }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("#f-service option")].some((o) => o.value === "Web広告"));
  check(true, "閉じると一覧の選択肢に反映");
  await page.goto(`${BASE}/sales/companies.html?new=1`);
  await page.locator("#q-url").waitFor();
  const svc = await page.locator("#q-service option").evaluateAll((os) => os.map((o) => o.value));
  const ind = await page.locator("#q-industry option").evaluateAll((os) => os.map((o) => o.value));
  check(svc.includes("Web広告") && !svc.includes("ENGER") && ind.includes("不動産・建設") && !ind.includes("不動産"),
    "新規登録：追加した値は選べ、非表示にした値は選べない");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 追加要件：アタック画面（地域・NEXT・キャンペーン・ページ送り・フォームアタックは別タブ・状態の保持） ===");
{
  const { page, calls, errs } = await openAs({ many: 130, extra: [
    { id: "a-none", name: "地域なし工業", domain: "none.jp", region: null },
    { id: "a-camp", name: "キャンペーン工業", domain: "camp2.jp", campaignId: "cp2", campaignName: "冬の不動産" },
    { id: "a-next", name: "電話する工業", domain: "tel.jp", next: "電話", nextKey: "manual", nextDue: TODAY },
    { id: "a-recent", name: "先週送った工業", domain: "recent.jp", lastSentAt: new Date(Date.now() - 7 * 86400000).toISOString(), status: "attacked" },
  ] });
  await page.goto(`${BASE}/sales/attack.html`);
  await page.locator("#queue .sl-row").first().waitFor();
  const first = calls.find((c) => c.kind === "list");
  check(first?.params.queue === "attack" && first.params.page === "1" && first.params.owner === "mine", "サーバーに queue=attack・1ページ目・自分＋担当なし");
  check(await page.locator("#queue .sl-row").count() === 100, "1ページ100社（「ほか○社」に隠さない）");
  const range = (await page.locator("#range").innerText()).trim();
  check(/^1–100 \/ 13\d件$/.test(range), `件数の表示（${range}）`);
  check(!(await page.locator("#queue").innerText()).includes("先週送った工業"), "30日以内にアタックした企業は出ない");
  // 14：次のページ
  await page.locator("#pager button", { hasText: "次へ" }).click();
  await page.waitForFunction(() => /page=2/.test(location.search) && (document.getElementById("range")?.innerText || "").startsWith("101–"));
  check(calls.filter((c) => c.kind === "list").at(-1).params.page === "2", "2ページ目はサーバーから取る");
  // 11：地域（未設定）
  await page.locator("#f-region").selectOption("none");
  await page.waitForFunction(() => /region=none/.test(location.search) && !document.querySelector("#queue.loading"));
  let names = await page.locator("#queue .sl-row b").allInnerTexts();
  check(JSON.stringify(names) === JSON.stringify(["地域なし工業"]), `地域「未設定」で絞る（${names.join("/")}）`);
  check((await page.locator("#f-region option").last().innerText()) === "未設定", "地域の選択肢に未設定");
  await page.locator("#f-region").selectOption("");
  // 12：NEXT
  await page.locator("#f-next").selectOption("manual");
  await page.waitForFunction(() => /next=manual/.test(location.search) && !/region=/.test(location.search) && !document.querySelector("#queue.loading"));
  names = await page.locator("#queue .sl-row b").allInnerTexts();
  check(JSON.stringify(names) === JSON.stringify(["電話する工業"]), `NEXTで絞る（${names.join("/")}）`);
  await page.locator("#f-next").selectOption("");
  // 13：キャンペーン
  await page.locator("#f-campaign").selectOption("cp2");
  await page.waitForFunction(() => /campaign=cp2/.test(location.search) && !/next=/.test(location.search) && !document.querySelector("#queue.loading"));
  names = await page.locator("#queue .sl-row b").allInnerTexts();
  check(JSON.stringify(names) === JSON.stringify(["キャンペーン工業"]), `キャンペーンで絞る（${names.join("/")}）`);
  check((await page.locator("#queue .sl-row").innerText()).includes("冬の不動産"), "キャンペーン名を出す");
  // 15・16：フォームアタックは別タブ。元のタブの条件・ページ・並び順はそのまま
  await page.locator("#f-campaign").selectOption("");
  await page.fill("#f-q", "企業1");
  await page.waitForFunction(() => /q=/.test(location.search) && !document.querySelector("#queue.loading"));
  await page.locator("#f-sort").selectOption("name:asc");
  await page.waitForFunction(() => /sort=name/.test(location.search) && !document.querySelector("#queue.loading"));
  await page.locator("#f-industry").selectOption("製造");
  await page.waitForFunction(() => /industry=/.test(location.search) && !document.querySelector("#queue.loading"));
  await page.locator("#pager button", { hasText: "2" }).first().click().catch(() => {});
  await page.waitForTimeout(300);
  const before = page.url();
  const firstId = await page.locator("#queue .sl-row").first().getAttribute("data-id");
  // window.open の引数を記録（新しいタブの中はモックが無いので、開いた URL と noopener をこちら側で見る）
  await page.evaluate(() => {
    const open = window.open.bind(window);
    window.__opened = [];
    window.open = (...args) => { window.__opened.push(args); return open(...args); };
  });
  const [tab] = await Promise.all([page.context().waitForEvent("page"), page.locator("#queue .sl-row button").first().click()]);
  const opened = await page.evaluate(() => window.__opened);
  check(tab.url().includes(`/sales/companies.html?attack=${firstId}`) || opened[0]?.[0] === `/sales/companies.html?attack=${firstId}`,
    `新しいタブでフォームアタック（${opened[0]?.[0]}）`);
  check(opened[0]?.[1] === "_blank" && /noopener/.test(opened[0]?.[2] || ""), "新しいタブ（_blank）・noopener で開く");
  await tab.close().catch(() => {});
  check(page.url() === before, "元のタブは同じ画面のまま（URL が変わらない）");
  const st = new URL(page.url()).searchParams;
  check(st.get("q") === "企業1" && st.get("sort") === "name" && st.get("industry") === "製造", "検索語・並び順・業種を URL に保持");
  check(await page.locator("#f-q").inputValue() === "企業1" && await page.locator("#f-industry").inputValue() === "製造", "入力欄もそのまま");
  const n0 = calls.filter((c) => c.kind === "list").length;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(500);
  const again = calls.filter((c) => c.kind === "list");
  check(again.length > n0 && again.at(-1).params.q === "企業1" && again.at(-1).params.industry === "製造" && again.at(-1).params.sort === "name",
    "戻ってきたら同じ条件で取り直す（送信した企業が外れる）");
  // URL を直接開いても復元
  await page.goto(`${BASE}/sales/attack.html?scope=all&region=none&page=1`);
  await page.locator("#queue .sl-row, #queue .sl-empty").first().waitFor();
  const r = calls.filter((c) => c.kind === "list").at(-1).params;
  check(r.region === "none" && !r.owner && await page.locator("#scope button.on").innerText() === "全員", "URL から条件（全員・未設定）を復元");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== CSVから取り込む：選ぶ → 確認 → 登録する（UTF-8・Shift_JIS） ===");
{
  const { writeFile, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  // Shift_JIS（Excel の「CSV」保存）を作る：TextDecoder の逆引き
  const sjisTable = new Map();
  const dec = new TextDecoder("shift_jis");
  for (let a = 0x81; a <= 0xfc; a++) {
    if (a > 0x9f && a < 0xe0) continue;
    for (let b = 0x40; b <= 0xfc; b++) {
      const ch = dec.decode(Uint8Array.from([a, b]));
      if (ch.length === 1 && ch !== "�" && !sjisTable.has(ch)) sjisTable.set(ch, [a, b]);
    }
  }
  const toSjis = (str) => Buffer.from([...str].flatMap((ch) => (ch.charCodeAt(0) < 0x80 ? [ch.charCodeAt(0)] : sjisTable.get(ch) || [0x3f])));
  const HEAD = "企業名,企業サイトURL,問い合わせフォームURL,業種,都道府県,所在地,提案サービス,電話番号,企業規模,メモ";
  const body = [
    HEAD,
    "株式会社かごしま製作所,https://www.kago-ss.jp/,,製造,鹿児島県鹿屋市,,AI / DX,,,",
    "\"株式会社サンプル（既存）\",https://sample.co.jp/,,不動産,東京都,,PCレンタル,,,",
    "株式会社ミチ,https://michi.jp,,未知の業種,千葉県,,AI / DX,,,",
    "株式会社かごしま製作所 支店,https://kago-ss.jp/branch,,製造,鹿児島県,,,,,",
    "\"株式会社カンマ, 改行\",https://comma.jp,,医療,大阪,,,,,\"1行目\n2行目\"",
  ].join("\r\n") + "\r\n";
  const dir = tmpdir();
  const utf8 = join(dir, "sales_utf8.csv"), bom = join(dir, "sales_bom.csv"), sjis = join(dir, "sales_sjis.csv"), txt = join(dir, "sales.txt");
  await writeFile(utf8, body, "utf8");
  await writeFile(bom, "﻿" + body, "utf8");
  await writeFile(sjis, toSjis(body));
  await writeFile(txt, body, "utf8");

  const { page, calls, errs } = await openAs({ importFailChunk: 0 });
  await page.goto(`${BASE}/sales/companies.html`);
  await page.locator("#rows tr[data-id]").first().waitFor();
  const btn = page.locator("button", { hasText: "CSVから取り込む" });
  check(await btn.count() === 1 && (await btn.innerText()).includes("upload_file"), "「CSVから取り込む」（upload_file）");
  check(!(await page.locator("button", { hasText: "スプレッドシート" }).count()), "「スプレッドシートから取り込む」は無くなった");
  await btn.click();
  const modal = page.locator(".sl-modal");
  await modal.waitFor();
  check((await modal.innerText()).includes("CSVで営業先企業をまとめて登録できます。"), "補足文");
  check(await page.locator(".sl-modal-bg").count() === 1 && !(await page.locator(".sl-drawer").count()), "中央モーダルで開く");
  check(await page.locator("#csv-drop").isVisible(), "ドラッグ&ドロップの枠");

  // テンプレート
  const [tpl] = await Promise.all([page.waitForEvent("download"), page.locator("button", { hasText: "CSVテンプレートをダウンロード" }).click()]);
  const tbuf = await readFile(await tpl.path());
  const ttext = tbuf.toString("utf8");
  check(tbuf[0] === 0xef && tbuf[1] === 0xbb && tbuf[2] === 0xbf, "テンプレートは BOM つき UTF-8");
  const TPL_HEAD = "企業名,企業サイトURL,問い合わせフォームURL,業種,都道府県,所在地,提案サービス,電話番号,メールアドレス,企業規模,メモ";
  check(ttext.replace(/^\ufeff/, "").split("\r\n")[0] === TPL_HEAD, `テンプレートの見出し（${ttext.split("\r\n")[0]}）`);
  check(ttext.includes('"info@example.co.jp,sales@example.co.jp"'), "例の行に複数メールアドレス（カンマ区切り）");
  check(/,製造,鹿児島県,/.test(ttext) && ttext.includes("AI / DX"), "例の行はマスターの値");

  // .csv 以外は受けない
  await page.locator("#csv-file").setInputFiles(txt);
  await page.waitForFunction(() => (document.getElementById("csv-msg")?.textContent || "").includes(".csv"));
  check(!calls.some((c) => c.kind === "csv-preview"), ".csv 以外は送らない");

  for (const [file, enc] of [[sjis, "Shift_JIS"], [bom, "UTF-8（BOMあり）"], [utf8, "UTF-8"]]) {
    await page.locator(".sl-modal-foot button", { hasText: "閉じる" }).click();
    await page.locator("button", { hasText: "CSVから取り込む" }).click();
    await page.locator("#csv-file").setInputFiles(file);
    await page.locator(".csv-tiles").waitFor();
    const txt2 = await page.locator("#csv-body").innerText();
    check(txt2.includes(enc), `${enc} として読める`);
    const p = calls.filter((c) => c.kind === "csv-preview").at(-1).body;
    check(p.commit === false && p.rows.length === 5 && p.rows[0].name === "株式会社かごしま製作所" && p.rows[0].region === "鹿児島県鹿屋市",
      `${enc}：文字化けせず5行を見出しで読む`);
    check(p.rows[4].name === "株式会社カンマ, 改行" && p.rows[4].note === "1行目\n2行目" && p.rows[4].row === 6, `${enc}："…" の中のカンマ・改行`);
  }
  check(calls.filter((c) => c.kind === "csv-commit").length === 0, "確認だけでは登録しない");
  const tiles = await page.locator(".csv-tiles").innerText();
  check(/読み込み\s*5件/.test(tiles) && /登録予定\s*2件/.test(tiles) && /重複\s*2件/.test(tiles) && /エラー\s*1件/.test(tiles),
    `件数（${tiles.replace(/\s+/g, " ")}）`);
  const rowText = (n) => page.locator(`#csv-body tr[data-row="${n}"]`).innerText();
  check((await rowText(2)).includes("鹿児島県") && !(await rowText(2)).includes("鹿屋市") && (await rowText(2)).includes("登録できる"), "鹿児島県鹿屋市 → 鹿児島県");
  check((await rowText(3)).includes("登録済みのためスキップ"), "既存のドメインは重複（スキップ）");
  check((await rowText(4)).includes("要修正") && (await rowText(4)).includes("未知の業種"), "マスター外の業種は要修正");
  check((await rowText(5)).includes("CSV内で重複"), "CSVの中の同じドメインは重複");
  check((await rowText(6)).includes("大阪府"), "「大阪」も大阪府に");

  // エラー行のダウンロード
  const [edl] = await Promise.all([page.waitForEvent("download"), page.locator("button", { hasText: "エラー行をCSVでダウンロード" }).click()]);
  const etext = (await readFile(await edl.path())).toString("utf8").replace(/^﻿/, "");
  const elines = etext.trim().split("\r\n");
  check(elines.length === 2 && elines[0].startsWith(TPL_HEAD) && elines[1].startsWith("株式会社ミチ,") && elines[1].includes("未知の業種"),
    `エラー行だけ（見出しはテンプレートと同じ＋理由）：${elines.length - 1}行`);

  await page.locator("#csv-go").click();
  await page.waitForFunction(() => (document.getElementById("csv-body")?.innerText || "").includes("件を登録しました"));
  const commits = calls.filter((c) => c.kind === "csv-commit");
  check(commits.length === 1 && commits[0].body.rows.map((r) => r.row).join() === "2,6", "登録は「登録できる」行だけを送る");
  const done = await page.locator("#csv-body").innerText();
  check(done.includes("5件中、2件を登録しました。重複2件、エラー1件です。"), "結果の件数");
  check(!(await page.locator("#csv-go").count()), "登録後は「登録する」を出さない（二重に押せない）");
  await page.waitForFunction(() => [...document.querySelectorAll("#f-region option")].some((o) => o.textContent === "鹿児島県（1）"));
  check((await page.locator("#range").innerText()).includes("/ 5件"), "登録後、一覧の件数と絞り込みの件数に反映");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();

  // 大量：50行ずつ送る。途中の1回が失敗しても、ほかは登録し、失敗した行が分かる
  const big = [HEAD, ...Array.from({ length: 130 }, (_, i) => `企業${i + 1},https://big${i + 1}.example.jp,,製造,福岡県,,,,,`)].join("\r\n");
  const bigFile = join(dir, "sales_big.csv");
  await writeFile(bigFile, big, "utf8");
  const b2 = await openAs({ importFailChunk: 2 });
  await b2.page.goto(`${BASE}/sales/companies.html`);
  await b2.page.locator("#rows tr[data-id]").first().waitFor();
  await b2.page.locator("button", { hasText: "CSVから取り込む" }).click();
  await b2.page.locator("#csv-file").setInputFiles(bigFile);
  await b2.page.locator("#csv-go").waitFor();
  await b2.page.locator("#csv-go").click();
  await b2.page.waitForFunction(() => (document.getElementById("csv-body")?.innerText || "").includes("件を登録しました"));
  const sizes = b2.calls.filter((c) => c.kind === "csv-commit").map((c) => c.body.rows.length);
  check(sizes.join() === "50,50,30", `50行ずつ送る（${sizes.join()}）`);
  const bt = await b2.page.locator("#csv-body").innerText();
  check(bt.includes("130件中、80件を登録しました。重複0件、エラー50件です。"), "失敗した50行はエラー、ほかは登録");
  check((await b2.page.locator('#csv-body tr[data-row="52"]').innerText()).includes("登録できませんでした")
    && (await b2.page.locator('#csv-body tr[data-row="2"]').innerText()).includes("登録しました"), "どの行が失敗したか分かる");
  check((await b2.page.locator("#csv-msg").innerText()).includes("送信に失敗"), "途中の失敗を知らせる");
  check(!b2.errs.length, `JSエラーなし ${b2.errs.join(" / ")}`);
  await b2.page.close();

  // スマホ幅でもはみ出さない
  const m = await openAs();
  await m.page.setViewportSize({ width: 375, height: 800 });
  await m.page.goto(`${BASE}/sales/companies.html`);
  await m.page.locator("#rows tr[data-id]").first().waitFor();
  await m.page.locator("button", { hasText: "CSVから取り込む" }).click();
  await m.page.locator("#csv-file").setInputFiles(utf8);
  await m.page.locator(".csv-tiles").waitFor();
  const over = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const box = await m.page.locator(".sl-modal").boundingBox();
  check(over <= 1 && box.width <= 375, `スマホ幅：モーダルがはみ出さない（${Math.round(box.width)}px）`);
  await m.page.close();
}

console.log("\n=== 一覧の取得に失敗しても画面は壊さない（再読み込みで戻る） ===");
{
  const { page, errs, ctlList } = await openAs({ failList: true });
  await page.goto(`${BASE}/sales/companies.html`);
  await page.locator("#rows .banner.err").waitFor();
  check((await page.locator("#rows").innerText()).includes("企業一覧を取得できませんでした"), "失敗を一覧の中に出す");
  check(await page.locator("#f-industry").isEnabled() && await page.locator("#btn-download").isEnabled(), "絞り込み・ボタンは使えるまま");
  ctlList.fail = false;
  await page.locator("#rows button", { hasText: "再読み込み" }).click();
  await page.locator("#rows tr[data-id]").first().waitFor();
  check(await page.locator("#rows tr[data-id]").count() === 3, "再読み込みで一覧が戻る");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== TimeRex で予約確定した商談：日時・Google Meet を出す。日時は手入力で変えない ===");
{
  const { page, calls, errs, meetings } = await openAs();
  meetings.push({ id: "mtx", companyId: "c2", ownerId: "emp-s1", kind: "first_meeting", status: "scheduled",
    schedulingUrl: "https://timerex.net/s/its_8888/b6915742?sales_company_id=c2&sales_meeting_id=mtx", schedulingSentAt: NOW,
    scheduledAt: "2026-10-05T01:00:00.000Z", meetingUrl: "https://meet.google.com/abc-defg-hij", fromTimerex: true });
  await page.goto(`${BASE}/sales/leads.html`);
  await page.waitForTimeout(900);
  await page.locator(".ld-card", { hasText: "反応商事" }).locator("button", { hasText: "商談予定を見る" }).click();
  await page.locator(".sl-modal h2", { hasText: "商談予定" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  check((await page.locator("#dt-meeting").innerText()).includes("商談予定を見る"), "TimeRex 予約済みなら CTA は「商談予定を見る」");
  check((await page.locator("#mt-stage").innerText()).trim() === "商談予定", "営業状態は「商談予定」");
  const txt = await page.locator(".sl-modal").innerText();
  check(txt.includes("商談予定：") && txt.includes("10:00"), `商談予定と日時（日本時間）を出す（${txt.replace(/\s+/g, " ").slice(0, 80)}）`);
  check(txt.includes("TimeRexで予約確定"), "TimeRex で予約確定した印");
  check(txt.includes("Google Meet：https://meet.google.com/abc-defg-hij"), "Google Meet の URL を出す");
  check(await page.locator(".sl-modal a", { hasText: "商談に参加" }).getAttribute("href") === "https://meet.google.com/abc-defg-hij", "「商談に参加」は Meet へ");
  check(await page.locator("#mt-when").count() === 0 && txt.includes("変更は TimeRex で"), "日時の手入力欄は出さない（変更は TimeRex で）");
  check(!calls.some((c) => c.kind === "meeting-PATCH"), "何も送らない");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 権限の無い人 ===");
{
  const { page } = await openAs({ roles: [] });
  await page.goto(`${BASE}/sales/index.html`);
  await page.waitForTimeout(1000);
  check(/home\.html/.test(page.url()), `home.html へ送り返す（いま ${page.url()}）`);
  await page.close();
}

console.log("\n=== 案件（企業詳細） ===");
{
  const { page, errs, calls } = await openAs({ deals: [{ id: "d1", companyId: "c2", title: "既存案件", stage: "proposal", amount: 500000 }] });
  await page.goto(`${BASE}/sales/companies.html?id=c2`);
  await page.waitForSelector("#detail-box .deal-row");
  const row = await page.locator("#detail-box .deal-row").first().innerText();
  check(/既存案件/.test(row) && /提案/.test(row) && /500,000円/.test(row) && /見込額 250,000円（50%）/.test(row), `案件が段階・金額・見込つきで出る（${row.replace(/\s+/g, " ")}）`);

  // 追加：金額と段階を入れる
  await page.click("text=案件を追加");
  await page.waitForSelector("#dl-title");
  const stages = await page.locator("#dl-stage option").allInnerTexts();
  check(stages.join() === "商談,提案,最終調整", `作るときの段階は進行中だけ（${stages.join()}）`);
  check(/既定の 20%/.test(await page.locator("#dl-prob-hint").innerText()), "確率の既定値を表示");
  await page.click(".sl-modal-foot >> text=追加");
  check(/案件名を入れてください/.test(await page.locator("#dl-msg").innerText()), "案件名が空なら送らない");
  await page.fill("#dl-title", "AI/DX 導入支援");
  await page.fill("#dl-amount", "1200000");
  await page.click(".sl-modal-foot >> text=追加");
  await page.waitForFunction(() => document.querySelectorAll("#detail-box .deal-row").length === 2);
  const made = calls.find((c) => c.kind === "deal-create");
  check(made && made.body.companyId === "c2" && made.body.title === "AI/DX 導入支援" && String(made.body.amount) === "1200000" && made.body.stage === "meeting",
    `案件の作成を送る（${JSON.stringify(made?.body)}）`);

  // 成約は金額が要る（画面でも止める）
  await page.locator("#detail-box .deal-row", { hasText: "AI/DX 導入支援" }).click();
  await page.waitForSelector("#dl-stage");
  await page.selectOption("#dl-stage", "won");
  check(await page.locator("#dl-prob-box").isHidden(), "成約では確率の欄を隠す");
  await page.fill("#dl-amount", "");
  await page.click(".sl-modal-foot >> text=保存");
  check(/0円より大きい案件金額を入れてください/.test(await page.locator("#dl-msg").innerText()), "金額なしの成約は送らない");
  await page.fill("#dl-amount", "0");
  await page.click(".sl-modal-foot >> text=保存");
  check(/0円より大きい案件金額を入れてください/.test(await page.locator("#dl-msg").innerText()), "0円の成約も送らない");
  await page.click(".sl-modal-foot >> text=閉じる");

  // 2件とも失注 → 「会社も失注にしますか」（はい）→ 会社の更新を送る
  for (const t of ["既存案件", "AI/DX 導入支援"]) {
    await page.locator("#detail-box .deal-row", { hasText: t }).click();
    await page.waitForSelector("#dl-stage");
    await page.selectOption("#dl-stage", "lost");
    check(await page.locator("#dl-lost-box").isVisible(), "失注では理由の欄を出す");
    await page.fill("#dl-lost", "予算なし");
    await page.click(".sl-modal-foot >> text=保存");
    await page.waitForTimeout(400);
  }
  const ups = calls.filter((c) => c.kind === "deal-update");
  check(ups.length === 2 && ups.every((u) => u.body.stage === "lost" && u.body.lostReason === "予算なし"), "失注と理由を送る");
  check(calls.some((c) => c.kind === "detail" && c.method === "PATCH"), "全部失注のときだけ、会社の失注を（確認のうえ）送る");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}
{
  const { page } = await openAs({ dealsNotReady: true });
  await page.goto(`${BASE}/sales/companies.html?id=c1`);
  await page.waitForSelector("#detail-box h4");
  check(/db\/116_sales_deals\.sql/.test(await page.locator("#detail-box").innerText()), "表が無いときは db/116 の実行を案内（詳細は開ける）");
  await page.close();
}

console.log("\n=== 分析（上部6マス） ===");
{
  const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const ap = (id, companyId, over = {}) => ({ id, companyId, companyName: `会社${companyId}`, companyStatus: "attacked", clickCount: 0,
    sentAt: ago(5), channelLabel: "お問い合わせフォーム", templateName: "AI/DX診断", service: "AI / DX", industry: "製造",
    employeeName: "営業 一郎", ...over });
  const analytics = [
    ap("a1", "k1", { clickCount: 2, companyStatus: "replied" }),
    ap("a2", "k2", { clickCount: 1, companyStatus: "clicked" }),
    ap("a3", "k3", { clickCount: 1, companyStatus: "lost" }),       // 失注でも案件があるので商談に数える
    ap("a4", "k4", { companyStatus: "won", templateName: "PCレンタル" }),
  ];
  const { page, errs } = await openAs({ analytics, deals: [
    { id: "d1", companyId: "k3", approachId: "a3", title: "失注案件", stage: "lost", amount: 900000 },
    { id: "d2", companyId: "k4", approachId: "a4", title: "成約案件", stage: "won", amount: 1500000, wonOn: TODAY },
    { id: "d3", companyId: "k1", approachId: "a1", title: "進行中", stage: "proposal", amount: 1000000 },
    // 期間内にアタックしていない会社の成約（上部の受注額には入る・要因分析には入らない）
    { id: "d4", companyId: "old", approachId: "a-old", companyName: "昔からの取引先", title: "追加発注", stage: "won", amount: 200000, wonOn: TODAY },
    // 成約日が期間より前（上部の受注額には入らない）
    { id: "d5", companyId: "k4", approachId: "a4", title: "去年の成約", stage: "won", amount: 5000000, wonOn: "2020-01-01" },
  ] });
  await page.goto(`${BASE}/sales/analytics.html`);
  await page.waitForSelector("#funnel .an2-card");
  const cards = await page.locator("#funnel .an2-card").allInnerTexts();
  const flat = cards.map((t) => t.replace(/\s+/g, " ").trim());
  check(flat.length === 6, `マスは6枚（${flat.length}）`);
  check(/^send 4社 アタック$/.test(flat[0]), `アタック 4社（${flat[0]}）`);
  check(/4社 クリック 100%（4 \/ 4）/.test(flat[1]), `クリック：後ろまで進んだ会社も通ったものとして数える（${flat[1]}）`);
  check(/3社 返信/.test(flat[2]), `返信 3社（${flat[2]}）`);
  check(/3社 商談 100%（3 \/ 3）.*4案件/.test(flat[3]), `商談 3社・4案件（1社に2案件・失注の会社も数える）（${flat[3]}）`);
  check(/1社 成約 33\.3%（1 \/ 3）/.test(flat[4]), `成約 1社（${flat[4]}）`);
  check(/¥1,700,000 受注額 成約日が期間内の 2案件/.test(flat[5]), `受注額＝成約日が期間内の成約案件の金額（アタックの時期は問わない）（${flat[5]}）`);
  check(/参考値/.test(flat[1]), "母数10未満は参考値");
  const money = (await page.locator(".an-money").innerText()).replace(/\s+/g, " ");
  check(/見込額 ¥500,000 進行中 1案件/.test(money) && /パイプライン ¥1,000,000/.test(money) && !/売上（/.test(money),
    `見込額・パイプライン（${money}）`);
  check(/会計上の売上ではありません/.test(money), "受注額は会計上の売上ではないと書く");
  const heads = await page.locator("#by-template thead th").allInnerTexts();
  check(heads.join("|") === "項目|アタック数|クリック率|返信率|商談化率|受注額|見込額|1アタック見込額", `既存の列に受注額の3列を足す（${heads.join("|")}）`);
  const tpl = (await page.locator("#by-template tbody tr", { hasText: "PCレンタル" }).innerText()).replace(/\s+/g, " ");
  check(/650万円/.test(tpl), `営業文別の受注額はもとのアタックで数える（成約日を問わない attribution）（${tpl}）`);
  await page.click("#funnel .an2-card >> nth=5");
  await page.waitForSelector(".sl-drawer");
  const dr = await page.locator(".sl-drawer").innerText();
  check(/成約案件/.test(dr) && /昔からの取引先/.test(dr) && !/去年の成約/.test(dr), "受注額のマスを押すと、成約日が期間内の案件を出す");
  await page.keyboard.press("Escape");
  await page.click("#funnel .an2-card >> nth=3");
  check(/会社k3/.test(await page.locator(".sl-drawer").innerText()), "商談のマスを押すと、商談した企業を出す");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}
{
  const { page, errs } = await openAs({ dealsNotReady: true, analytics: [{ id: "a1", companyId: "k1", companyName: "会社k1",
    companyStatus: "attacked", clickCount: 0, sentAt: NOW, channelLabel: "お問い合わせフォーム" }] });
  await page.goto(`${BASE}/sales/analytics.html`);
  await page.waitForSelector("#funnel .an2-card");
  const t = await page.locator("#kpi").innerText();
  check(/db\/116_sales_deals\.sql/.test(t) && /1社/.test(t), "案件の表が無くても、活動のマスは出して db/116 を案内");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

{
  // 案件が5,000件を超えたら（API の truncated）、集計が一部省略されていると画面に出す
  const { page, errs } = await openAs({ dealsTruncated: true, analytics: [{ id: "a1", companyId: "k1", companyName: "会社k1",
    companyStatus: "attacked", clickCount: 0, sentAt: NOW, channelLabel: "お問い合わせフォーム" }],
    deals: [{ id: "d1", companyId: "k1", approachId: "a1", title: "進行中", stage: "proposal", amount: 1000000 }] });
  await page.goto(`${BASE}/sales/analytics.html`);
  await page.waitForSelector("#funnel .an2-card");
  const b = page.locator("#deals-truncated");
  check(await b.isVisible(), "truncated のときは警告を出す");
  check(/5,000件超で集計が一部省略されています/.test(await b.innerText()), `警告の文言（${(await b.innerText()).replace(/\s+/g, " ")}）`);
  check(await page.locator(".an-money").isVisible(), "警告を出しても数字は出す");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}
{
  const { page } = await openAs({ analytics: [{ id: "a1", companyId: "k1", companyName: "会社k1",
    companyStatus: "attacked", clickCount: 0, sentAt: NOW, channelLabel: "お問い合わせフォーム" }] });
  await page.goto(`${BASE}/sales/analytics.html`);
  await page.waitForSelector("#funnel .an2-card");
  check(!(await page.locator("#deals-truncated").count()), "5,000件以下なら警告は出さない");
  await page.close();
}
{
  // 期間の始まりは日本時間。UTC ではまだ 9/30 20:00 でも、日本時間では 10/1 05:00 → 直近30日は 9/2 から（UTC で30日前に切ると 8/31・9/1 を入れてしまう）
  const deals = [
    { id: "w1", companyId: "k1", approachId: null, companyName: "初日", title: "初日の成約", stage: "won", amount: 100000, wonOn: "2026-09-02" },
    { id: "w2", companyId: "k1", approachId: null, companyName: "前日", title: "前日の成約", stage: "won", amount: 7000000, wonOn: "2026-09-01" },
  ];
  const analytics = [{ id: "a1", companyId: "k1", companyName: "会社k1", companyStatus: "attacked", clickCount: 0,
    sentAt: "2026-09-30T19:00:00Z", channelLabel: "お問い合わせフォーム" }];
  for (const [since, label] of [[null, "API が since を返さない版でも画面で日本時間で計算"], ["2026-09-02", "API の since を使う"]]) {
    const { page, errs } = await openAs({ analytics, analyticsSince: since, deals });
    await page.clock.setFixedTime(new Date("2026-09-30T20:00:00Z"));
    await page.goto(`${BASE}/sales/analytics.html`);
    await page.waitForSelector("#period button");
    await page.click("#period button >> text=30日");
    await page.waitForFunction(() => /2026-09-02/.test(document.querySelector("#kpi")?.innerText || ""));
    const flat = (await page.locator("#funnel .an2-card >> nth=5").innerText()).replace(/\s+/g, " ");
    check(/¥100,000 受注額 成約日が期間内の 1案件/.test(flat), `${label}：始まりの日（9/2）は入れ、前日（9/1）は入れない（${flat}）`);
    check(/期間：2026-09-02 〜 今日（日本時間）/.test(await page.locator("#kpi").innerText()), `${label}：期間の始まりを日本時間の日付で出す`);
    check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
    await page.close();
  }
}

console.log("\n=== 企業一覧：キャンペーンで絞る（すべて／各キャンペーン／なし）。URL・ページ・詳細から戻っても保つ ===");
{
  const extra = [];
  for (let i = 1; i <= 130; i++) extra.push({ id: `k${i}`, name: `秋社${String(i).padStart(3, "0")}`, domain: `k${i}.jp`, campaignId: "cp1", campaignName: "秋の製造業" });
  const { page, calls, errs } = await openAs({ extra });
  await page.goto(`${BASE}/sales/companies.html`);
  await page.locator("#rows tr[data-id]").first().waitFor();
  const opts = await page.locator("#f-campaign option").allInnerTexts();
  check(opts[0] === "キャンペーン：すべて" && opts.includes("秋の製造業") && opts.includes("冬の不動産") && opts.at(-1) === "キャンペーンなし",
    `選択肢：すべて・各キャンペーン・なし（${opts.join(" / ")}）`);
  check(opts.every((o) => !/（\d+）/.test(o)), "キャンペーンには件数を付けない（数えていない数字を出さない）");
  await page.locator("#f-campaign").selectOption("cp1");
  await page.waitForFunction(() => /campaign=cp1/.test(location.search) && !document.querySelector("#rows.loading"));
  let last = calls.filter((c) => c.kind === "list").at(-1).params;
  check(last.campaign === "cp1" && last.page === "1", "キャンペーンIDで絞って、サーバーに頼む（1ページ目から）");
  check((await page.locator("#range").innerText()).includes("/ 130件"), "絞ったぶんの件数");
  // 他の絞り込み・検索と一緒に
  await page.locator("#f-industry").selectOption("製造");
  await page.waitForFunction(() => /industry=/.test(location.search) && !document.querySelector("#rows.loading"));
  last = calls.filter((c) => c.kind === "list").at(-1).params;
  check(last.campaign === "cp1" && last.industry === "製造", "業種と一緒に絞れる");
  await page.locator("#f-industry").selectOption("");
  await page.waitForFunction(() => !/industry=/.test(location.search) && !document.querySelector("#rows.loading"));
  // ページを送っても保つ
  await page.locator("#pager button", { hasText: "次へ" }).click();
  await page.waitForFunction(() => /page=2/.test(location.search) && !document.querySelector("#rows.loading"));
  last = calls.filter((c) => c.kind === "list").at(-1).params;
  check(last.page === "2" && last.campaign === "cp1", "2ページ目もキャンペーンの条件のまま");
  // 詳細を開いて閉じても保つ
  await page.locator("#rows tr[data-id]").first().click();
  await page.locator("#detail-box").waitFor();
  check(/campaign=cp1/.test(page.url()) && /id=/.test(page.url()), "詳細を開いても URL に条件が残る");
  await page.locator(".sl-detail button", { hasText: "閉じる" }).first().click();
  await page.waitForTimeout(300);
  const st = new URL(page.url()).searchParams;
  check(st.get("campaign") === "cp1" && st.get("page") === "2" && !st.get("id"), "詳細を閉じても、条件・ページはそのまま");
  check(await page.locator("#f-campaign").inputValue() === "cp1", "選んだキャンペーンが表示されたまま");
  // キャンペーンなし
  await page.locator("#f-campaign").selectOption("none");
  await page.waitForFunction(() => /campaign=none/.test(location.search) && !document.querySelector("#rows.loading"));
  last = calls.filter((c) => c.kind === "list").at(-1).params;
  check(last.campaign === "none" && last.page === "1", "「キャンペーンなし」で絞れる");
  check((await page.locator("#rows").innerText()).includes("株式会社サンプル") && !(await page.locator("#rows").innerText()).includes("秋社001"),
    "キャンペーンの無い企業だけ");
  // URL を直接開いても復元
  await page.goto(`${BASE}/sales/companies.html?campaign=cp1&industry=%E8%A3%BD%E9%80%A0`);
  await page.locator("#rows tr[data-id], #rows .empty").first().waitFor();
  await page.waitForTimeout(200);
  check(await page.locator("#f-campaign").inputValue() === "cp1" && await page.locator("#f-industry").inputValue() === "製造", "URL から条件を復元");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== アタック画面：既定はアタック優先順（サーバーで並べる） ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/attack.html`);
  await page.locator("#queue .sl-row, #queue .sl-empty").first().waitFor();
  const p = calls.filter((c) => c.kind === "list").at(-1).params;
  check(p.queue === "attack" && p.sort === "priority" && p.order === "asc", `既定の並び順は sort=priority（${p.sort}）`);
  check(await page.locator("#f-sort").inputValue() === "priority:asc" && (await page.locator("#f-sort option").first().innerText()) === "アタック優先順",
    "並び順の選択肢の先頭は「アタック優先順」");
  check(!/sort=/.test(page.url()), "既定の並び順は URL に書かない");
  await page.locator("#f-sort").selectOption("next:asc");
  await page.waitForFunction(() => /sort=next/.test(location.search));
  check(calls.filter((c) => c.kind === "list").at(-1).params.sort === "next", "NEXTの急ぐ順も選べる");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== フォームアタック（?attack=）：一覧を待たずにアタック画面を出す ===");
{
  const { page, calls, errs, ctlList } = await openAs();
  ctlList.delay = 4000;   // 一覧（100社・絞り込みの件数）が重い日
  const t0 = Date.now();
  await page.goto(`${BASE}/sales/companies.html?attack=c1`);
  await page.locator("button", { hasText: "送信完了" }).waitFor();
  const ms = Date.now() - t0;
  check(ms < 3000, `一覧の取得（4秒）を待たずに、操作できる状態になる（${ms}ms）`);
  const kinds = calls.map((c) => c.kind);
  const firstList = kinds.indexOf("list");
  check(kinds.indexOf("detail") >= 0 && kinds.indexOf("prepare") >= 0 && (firstList < 0 || firstList > kinds.indexOf("prepare")),
    `企業詳細・専用URLの発行を先に頼む（${kinds.slice(0, 5).join(" → ")}）`);
  check((await page.locator("#at-service").inputValue()) === "AI / DX" && await page.locator("#dl-at-service option").count() > 3,
    "提案サービスの候補は、企業詳細の応答から使う（一覧が届く前でも）");
  await page.waitForFunction(() => document.querySelectorAll("#rows tr[data-id]").length > 0, null, { timeout: 8000 });
  check(true, "一覧はあとから裏で取る");
  check(new URL(page.url()).searchParams.get("attack") === "c1", "一覧が届いても、アタック画面の URL はそのまま");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== フォームアタック画面：基本情報を編集 → すぐ反映（一覧にも） ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/companies.html?attack=c1`);
  await page.locator("#at-body").waitFor();
  await page.fill("#at-body", "手で直した本文");
  await page.locator(".atk-tools button", { hasText: "基本情報を編集" }).click();
  await page.locator(".sl-modal h2", { hasText: "基本情報を編集" }).waitFor();
  check(await page.locator(".sl-modal #c-name").inputValue() === "株式会社サンプル", "企業詳細と同じ編集画面（js/sales-detail.js openEdit）");
  await page.fill(".sl-modal #c-name", "株式会社サンプル改");
  const nList = calls.filter((c) => c.kind === "list").length;
  await page.locator(".sl-modal button", { hasText: "保存する" }).click();
  await page.waitForFunction(() => document.querySelector(".atk-head h2")?.textContent.includes("株式会社サンプル改"));
  check(calls.some((c) => c.kind === "patch-basic" && c.body.id === "c1" && c.body.name === "株式会社サンプル改"), "同じ API（PATCH /api/sales/companies/detail）で保存");
  check((await page.locator("#at-company").innerText()).includes("株式会社サンプル改"), "アタック画面の企業情報にすぐ反映");
  check(await page.locator("#at-body").inputValue() === "手で直した本文", "書きかけの本文は消さない");
  await page.waitForTimeout(400);
  check(calls.filter((c) => c.kind === "list").length > nList, "企業一覧も取り直す");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 企業の削除：履歴なし → 確認して削除／履歴あり → 削除できない・一覧から非表示 ===");
{
  const { page, calls, errs } = await openAs();
  // フォームアタック画面から（開いた時点の準備だけのアタックは、履歴に数えないよう指定して確かめる）
  await page.goto(`${BASE}/sales/companies.html?attack=c1`);
  await page.locator("#at-body").waitFor();
  await page.locator(".atk-tools button", { hasText: "削除" }).click();
  await page.locator("#del-go").waitFor();
  const t = await page.locator(".sl-modal").innerText();
  check(t.includes("この企業を削除します。") && t.includes("削除後は元に戻せません。"), "削除できるとき：元に戻せないことを出す");
  check(await page.locator(".sl-modal button", { hasText: "キャンセル" }).count() === 1, "［キャンセル］［削除する］");
  const dry = calls.find((c) => c.kind === "bulk-delete-dry");
  check(dry && dry.body.ids.join() === "c1" && dry.body.ignoreApproachId === "ap1", "先に dryRun で確かめる（準備中のアタック ap1 は数えない指定）");
  await page.locator("#del-go").click();
  await page.waitForFunction(() => !document.querySelector(".atk"));
  check(calls.some((c) => c.kind === "bulk-delete" && c.body.ids.join() === "c1" && !c.body.dryRun), "削除する");
  check((await page.locator("#notice").innerText()).includes("株式会社サンプル を削除しました"), "一覧に戻って、削除したことを出す");
  check(!/attack=/.test(page.url()), "アタック画面の URL を外す");

  // 企業詳細から：履歴がある企業
  await page.goto(`${BASE}/sales/companies.html?id=c2`);
  await page.locator("#detail-box .dt-delete").waitFor();
  await page.locator("#detail-box .dt-delete").click();
  await page.locator("#del-reasons").waitFor();
  const b = await page.locator(".sl-modal").innerText();
  check(b.includes("この企業には営業履歴があるため削除できません。") && b.includes("企業一覧から非表示にすることはできます。"), "削除できないときの文言");
  check((await page.locator("#del-reasons").innerText()).includes("アタック履歴あり"), "理由を出す");
  check(!(await page.locator("#del-go").count()), "削除するボタンは出さない（履歴を消して削除する手段は作らない）");
  await page.locator(".sl-modal button", { hasText: "一覧から非表示" }).click();
  await page.locator(".sl-modal h2", { hasText: "この企業を非表示にします" }).waitFor();
  await page.locator(".sl-modal input[name='dt-hide'][value='not_target'], .sl-modal input[value='not_target']").first().check().catch(() => {});
  await page.locator(".sl-modal button", { hasText: "非表示にする" }).click();
  await page.waitForTimeout(500);
  check(calls.some((c) => c.kind === "bulk-hide" && c.body.ids.join() === "c2"), "そのまま一覧から非表示にできる");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== フォームアタック画面から一覧から非表示 → アタックしない ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/companies.html?attack=c1`);
  await page.locator("#at-body").waitFor();
  await page.locator(".atk-tools button", { hasText: "一覧から非表示" }).click();
  await page.locator(".sl-modal h2", { hasText: "この企業を非表示にします" }).waitFor();
  await page.locator(".sl-modal input[value='link_broken']").first().check().catch(() => {});
  await page.locator(".sl-modal button", { hasText: "非表示にする" }).click();
  await page.waitForFunction(() => (document.querySelector(".atk")?.innerText || "").includes("一覧から非表示にしました"));
  check(calls.some((c) => c.kind === "bulk-hide" && c.body.ids.join() === "c1"), "非表示にした");
  check(!(await page.locator("#at-body").count()), "営業文を出さない（アタックしない）");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 分析：担当者別フォームアタック数（本日〜先月・任意期間。既定は今週） ===");
{
  const LABEL = { today: "本日", yesterday: "昨日", this_week: "今週", last_week: "先週", this_month: "今月", last_month: "先月", custom: "任意期間" };
  const repCounts = (p) => ({
    period: { key: p.period, label: LABEL[p.period], from: p.from || "2026-10-05", to: p.to || "2026-10-07", days: 3 },
    rows: [{ employeeId: "e1", name: "中村", count: 152 }, { employeeId: "e2", name: "山内", count: 98 },
      { employeeId: "e3", name: "藤本", count: 34 }, { employeeId: "e4", name: "新人", count: 0 }],
    total: 284, zeroMembers: "listed",
  });
  const { page, calls, errs } = await openAs({ repCounts });
  await page.goto(`${BASE}/sales/analytics.html`);
  await page.locator("#rep-table").waitFor();
  const first = calls.find((c) => c.kind === "counts");
  check(first?.params.period === "this_week", "既定は今週");
  check(await page.locator("#rep-period button.on").innerText() === "今週", "今週が選ばれている");
  const pills = await page.locator("#rep-period button").allInnerTexts();
  check(pills.join(",") === "本日,昨日,今週,先週,今月,先月,任意期間", `期間の選択肢（${pills.join(",")}）`);
  const body = await page.locator("#rep-body").innerText();
  check(body.includes("期間：今週") && /中村\s+152件/.test(body) && /新人\s+0件/.test(body), "担当者ごとの件数（0件の人も）");
  check((await page.locator("#rep-total").innerText()) === "284件", "合計");
  for (const k of ["today", "yesterday", "last_week", "this_month", "last_month"]) {
    await page.locator("#rep-period button", { hasText: LABEL[k] }).click();
    await page.waitForFunction((l) => document.querySelector("#rep-body")?.innerText.includes(`期間：${l}`), LABEL[k]);
    check(calls.filter((c) => c.kind === "counts").at(-1).params.period === k, `${LABEL[k]}で数え直す`);
  }
  check(new URL(page.url()).searchParams.get("rp") === "last_month", "期間を URL に残す");
  await page.locator("#rep-period button", { hasText: "任意期間" }).click();
  check(await page.locator("#rep-range").isVisible(), "任意期間：開始日・終了日を出す");
  await page.fill("#rep-from", "2026-09-01");
  await page.fill("#rep-to", "2026-09-30");
  await page.locator("#rep-range button", { hasText: "集計する" }).click();
  await page.waitForFunction(() => document.querySelector("#rep-body")?.innerText.includes("期間：任意期間"));
  const c = calls.filter((x) => x.kind === "counts").at(-1).params;
  check(c.period === "custom" && c.from === "2026-09-01" && c.to === "2026-09-30", "任意期間で数える（from・to）");
  check((await page.locator("#rep-body").innerText()).includes("9/1〜9/30"), "期間を日付で出す");
  // 再読み込みしても同じ期間
  await page.reload();
  await page.locator("#rep-table").waitFor();
  const r = calls.filter((x) => x.kind === "counts").at(-1).params;
  check(r.period === "custom" && r.from === "2026-09-01", "URL から期間を復元");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== スマホ幅 ===");
{
  const { page, errs } = await openAs();
  await page.setViewportSize({ width: 375, height: 800 });
  for (const p of ["index", "companies", "attack", "leads", "analytics", "templates", "campaigns"]) {
    await page.goto(`${BASE}/sales/${p}.html`);
    await page.waitForTimeout(700);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(over <= 1, `${p}.html 横にはみ出さない（${over}px）`);
  }
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 失敗` : "\nすべて通りました");
process.exit(bad ? 1 : 0);
