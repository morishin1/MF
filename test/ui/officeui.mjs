// 月末月初業務（/office/）を、実際のブラウザで通す。
//
// ■ 何を守るテストか
//
//   1. 経理（access.office）でログインすると、専用ヘッダー（EIGHT/OFFICE）・数字カード6つ・
//      今日やること・月次進捗・案件一覧（左端のチェック列＋10列）が出る
//   2. カード・今日やること・選択肢のどれから絞っても、同じ結果になる（一覧の tags で答える）。
//      検索・区分・「未完了のみ」・リセット
//   3. 月を切り替えると、その月を読み直す。「今月」で今月へ戻る
//   4. 行をクリックすると右ドロワー。順番は 契約→勤務表→稼働計算→売上請求→発注→仕入請求→支払→履歴。
//      「要対応」ボタンは該当の場所へ。提出ファイルは署名URLで開く。Esc で閉じて、元の場所へ戻る。
//      URL（?id=）で、開いた状態を再現できる
//   5. 単価・精算条件は、どこにも出ない（意味が確認できるまで）
//   6. Office 権限の無い人は home.html へ、未ログインは index.html へ送る。
//      サーバが mfa_required を返したときの共通の遷移（js/api-client.js）は、/mypage.html#mfa へ（階層の違う画面から、行き止まりにならない）。
//      Office の API は MFA を要求しなくなった（2026-09-30）ので、通常は起きない。経営者が MFA なしで入れることは test/ui/officeownerui.mjs
//   7. 権限の設定が未適用・表が無い・取得失敗は、画面に理由が出る
//   8. スマホ幅で、横スクロールが要らない（表はカードになる）
//
// API の応答は、本物の lib/office.js から組み立てる（API と画面の契約が食い違えば落ちる）
import { launch, BASE } from "../_browser.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const O = await import(join(ROOT, "lib/office.js"));

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

// ---- 応答の材料（本物の lib/office.js で導く） -----------------------------------
const NONE = { timesheet_received: false, work_confirmed: false, board_created: false, sent: false, bp_invoice_received: false };
const ALL_SALES = { timesheet_received: true, work_confirmed: true, board_created: true, sent: true };
const marks = (m) => {
  const o = { ...NONE, ...m };
  for (const k of Object.keys(NONE)) o[`${k}_at`] = o[k] ? "2026-09-30T01:00:00Z" : null;
  return o;
};
const F1 = "11111111-1111-4111-8111-111111111111";
const F2 = "22222222-2222-4222-8222-222222222222";
const raw = (id, name, extra, m, files = []) => ({
  siteContractId: id, progressId: null, employeeId: `e-${id}`, employeeName: name, department: null,
  employeeKind: "proper", partnerName: null, engagementKind: "pp", siteCompany: `顧客${id}社`, primeCompany: null,
  periodFrom: "2026-04-01", periodTo: null, renewalStatus: "confirmed", marks: marks(m), submissions: files, ...extra,
});
const BP = { engagementKind: "bp", employeeKind: "bp", partnerName: "株式会社ビーピー" };
const build = (month, today, list) => {
  const deadline = O.timesheetDeadline(month);
  const rows = list.map((r) => O.deriveRow(r, { today, deadline }));
  return { month, today, deadline, rows: O.sortRows(rows), summary: O.summarize(rows), stages: O.STAGES, filters: O.FILTERS };
};
const SEPT = () => build("2026-09", "2026-10-06", [
  raw("A", "田中 太郎", { department: "常駐部" }, { timesheet_received: true }, [{ id: F1, kind: "timesheet", fileName: "田中_9月.pdf", submittedAt: "2026-09-30T01:00:00Z" }]),
  raw("B", "鈴木 花子", { ...BP, primeCompany: "上位商事" }, {}),                                           // 勤務表待ち（期限超過）
  raw("C", "佐藤 次郎", {}, { timesheet_received: true, work_confirmed: true }),                          // 請求作成待ち
  raw("D", "高橋 三郎", { ...BP }, { ...ALL_SALES }),                                                      // 仕入請求待ち
  raw("E", "伊藤 四郎", {}, { ...ALL_SALES }),                                                              // 完了
  raw("F", "渡辺 五郎", { ...BP }, { ...ALL_SALES, bp_invoice_received: true }, [{ id: F2, kind: "invoice", fileName: "BP請求書.pdf", submittedAt: "2026-09-30T02:00:00Z" }]), // 支払準備
  raw("G", "小林 六郎", {}, { timesheet_received: true, board_created: true }),                            // 稼働確認待ち＋要確認（稼働確認が無いのに請求書が作成済み）
]);
const OCT = () => build("2026-10", "2026-10-06", []);

const jstMonth = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7);

// ---- 共通の準備 -----------------------------------------------------------------
async function open(url, { access = { office: true }, loggedIn = true, officeResponse, viewport = { width: 1400, height: 1000 } } = {}) {
  const requests = { office: [], file: [] };
  const page = await br.newPage({ viewport, timezoneId: "Asia/Tokyo" });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.googleapis|net::ERR|Failed to load resource|manifest/.test(m.text())) errs.push(m.text()); });
  await page.addInitScript((li) => {
    if (li) localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "keiri@8grp.co.jp" }));
    window.__opened = [];
    window.open = () => ({ location: { set href(v) { window.__opened.push(v); } }, close() { window.__closed = true; }, opener: null });
  }, loggedIn);
  await page.route("**/api/**", (route) => {
    const u = new URL(route.request().url());
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/api/me") {
      const me = { email: "keiri@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
        gw: { employee: { id: "e-me", display_name: "経理 花子", status: "active" }, roles: ["finance"], isAdmin: false, tenantId: "t1", stage: null } };
      if (access !== null) me.access = access;          // null は「access の項目そのものが無い」（古い応答）
      return send(me);
    }
    if (u.pathname === "/api/office/file") {
      requests.file.push(u.searchParams.get("id"));
      return send({ url: "https://storage.example/x.pdf?token=t", filename: "x.pdf", expiresInSec: 300 });
    }
    if (u.pathname === "/api/office") {
      const month = u.searchParams.get("month") || jstMonth();
      requests.office.push(month);
      if (officeResponse) { const r = officeResponse(month); return send(r.body, r.status || 200); }
      return send(month === "2026-09" ? SEPT() : { ...OCT(), month });
    }
    if (u.pathname.startsWith("/api/notifications")) return send({ notifications: [], unread: 0 });
    if (u.pathname.startsWith("/api/badges")) return send({ badges: {} });
    return send({});
  });
  await page.goto(`${BASE}${url}`);
  return { page, requests, errs };
}
const rowsText = (page) => page.locator("#rows tr[data-id]").evaluateAll((t) => t.map((r) => r.querySelector('[data-label="要員"] .of-nm')?.textContent));

// ============================================================================
console.log("\n=== 経理：ダッシュボード ===");
{
  const { page, requests, errs } = await open("/office/index.html?month=2026-09");
  await page.waitForSelector("#rows tr[data-id]");

  check(/OFFICE/.test(await page.locator(".of-logo").innerText()), "専用ヘッダー（EIGHT / OFFICE）");
  check((await page.locator(".of-nav a.on").innerText()).includes("月次業務"), "ナビ：月次業務が選ばれている");
  check(requests.office[0] === "2026-09", "月を指定して読む");

  const labels = await page.locator("#sum .of-card .lb").evaluateAll((l) => l.map((x) => x.lastChild.textContent.trim()));
  check(labels.join("|") === "対象案件|勤務表待ち|稼働確認待ち|請求未送付|仕入請求待ち|完了", `数字カードは6つ（いま ${labels.join("|")}）`);
  const vals = await page.locator("#sum .of-card .v").allInnerTexts();
  check(vals[0] === "7" && vals[1] === "1" && vals[2] === "2" && vals[3] === "1" && vals[4] === "1" && vals[5].replace(/\s/g, "") === "1/7",
    `カードの数字（対象7・勤務表待ち1・稼働確認2・請求未送付1・仕入請求1・完了 1/7）いま ${vals.join(",")}`);
  check(await page.locator("#sum .of-card.hot").count() === 1, "期限超過がある勤務表待ちだけ、警告色");

  const today = await page.locator("#today button").allInnerTexts();
  check(today.some((t) => t.includes("勤務表未提出") && t.includes("うち期限超過 1件")), "今日やること：勤務表未提出（うち期限超過 1件）");
  check(today.some((t) => t.includes("稼働確認待ち")) && today.some((t) => t.includes("要確認")), "今日やること：稼働確認待ち・要確認");
  check(!today.some((t) => t.includes("期限超過") && !t.includes("うち")), "期限超過は未提出の内訳で、別項目に並べない");
  check(await page.locator("#prog .row").count() === 5, "月次進捗は5本");
  const prog = (await page.locator("#prog .num").allInnerTexts()).join("|");
  check(prog === "6 / 7|4 / 7|3 / 7|1 / 3|1 / 7", `進捗：勤務表回収 6/7・稼働確認 4/7・売上請求(送付) 3/7・仕入請求(BPだけ) 1/3・完了 1/7（いま ${prog}）`);
  check((await page.locator("#prog .row").first().locator('[role="progressbar"]').getAttribute("aria-valuenow")) === "6", "進捗バーは、数字も読み上げ用に持つ");

  const heads = await page.locator(".of-table thead th").allInnerTexts();
  check(heads.join("|") === "|客先|案件|要員|勤務表|稼働時間|売上請求|仕入請求|支払|現在工程|次にやること", `一覧は、左端の選択（チェック）の列＋要件の10列（いま ${heads.join("|")}）`);

  const names = await rowsText(page);
  check(names.length === 6 && !names.includes("伊藤 四郎"), `既定は未完了のみ（完了の伊藤さんは出ない）: ${names.join(",")}`);
  check(names[0] === "鈴木 花子", "並びの先頭は期限超過");

  const suzuki = page.locator('#rows tr:has-text("鈴木 花子")');
  const t = await suzuki.innerText();
  check(t.includes("期限超過") && t.includes("勤務表待ち") && t.includes("提出状況を見る"), "期限超過の行：期限超過・現在工程・要対応ボタン");
  check(t.includes("株式会社ビーピー") && t.includes("上位：上位商事") && t.includes("BP"), "BP：BP会社・上位会社・区分");
  check(t.includes("未管理") && t.includes("未受領"), "BP：仕入請求は未受領、支払は未管理");
  // 状態は 色＋文字＋アイコン。未完了に ○ は使わない。チェックは完了（緑）だけ
  check(await suzuki.locator('[data-label="勤務表"] .of-st.red').count() === 1, "未提出は赤");
  check(await suzuki.locator('[data-label="仕入請求"] .of-st.orange').count() === 1 && await suzuki.locator('[data-label="売上請求"] .of-st.orange').count() === 1, "未受領・未作成は橙");
  check(await suzuki.locator('[data-label="支払"] .of-st.gray').count() === 1, "未管理は灰");
  check(await page.locator('#rows tr:has-text("田中 太郎") [data-label="仕入請求"] .of-st.gray').count() === 1, "対象外は灰");
  check(!(await page.content()).includes("radio_button_unchecked"), "一覧のどこにも ○（radio_button_unchecked）を使っていない");
  const checkPills = await page.locator("#rows .of-st").evaluateAll((ns) => ns.filter((n) => n.textContent.includes("check_circle")).map((n) => n.className));
  check(checkPills.length > 0 && checkPills.every((c) => c.includes("green")), `チェックのアイコンは、完了（緑）のラベルだけ（${checkPills.length}個）`);
  const tanaka = await page.locator('#rows tr:has-text("田中 太郎")').innerText();
  check(tanaka.includes("提出済") && tanaka.includes("ファイル 1件") && tanaka.includes("稼働確認待ち"), "PP：勤務表 提出済・ファイル1件・現在工程");
  check((await page.locator('#rows tr:has-text("田中 太郎")').innerText()).includes("対象外"), "PP：仕入請求・支払は対象外");
  const kobayashi = await page.locator('#rows tr:has-text("小林 六郎")').innerText();
  check(kobayashi.includes("要確認"), "印が順番どおりでない行は「要確認」（他の行は止めない）");
  check(await page.locator(".of-table td", { hasText: /\d{3},\d{3}円|単価/ }).count() === 0, "一覧に単価は出ない");
  check(errs.length === 0, `ブラウザのエラーが無い ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 絞り込み ===");
{
  const { page } = await open("/office/index.html?month=2026-09");
  await page.waitForSelector("#rows tr[data-id]");
  const count = async () => (await rowsText(page)).length;

  await page.locator('#sum .of-card[data-tag="timesheet"]').click();
  check((await rowsText(page)).join() === "鈴木 花子" && (await page.locator('#sum .of-card[data-tag="timesheet"]').getAttribute("aria-pressed")) === "true", "カード「勤務表待ち」→ 鈴木さん（押した状態が分かる）");
  await page.locator('#sum .of-card[data-tag="timesheet"]').click();
  check(await count() === 6, "もう一度押すと、絞り込みが外れる");

  await page.locator('#today button[data-tag="work"]').click();
  check((await rowsText(page)).sort().join() === ["小林 六郎", "田中 太郎"].sort().join(), "今日やること「稼働確認待ち」→ 田中さん・小林さん");
  check((await page.locator("#fstage").inputValue()) === "work", "選択肢も同じ値に揃う（同じ絞り込みの印）");

  await page.locator("#reset").click();
  await page.locator("#fstage").selectOption("overdue");
  check((await rowsText(page)).join() === "鈴木 花子", "選択肢「勤務表 期限超過」→ 鈴木さんだけ");
  await page.locator("#fstage").selectOption("check");
  check((await rowsText(page)).join() === "小林 六郎", "選択肢「要確認」→ 小林さんだけ");

  await page.locator("#reset").click();
  await page.locator("#q").fill("ビーピー");
  check((await rowsText(page)).sort().join() === ["渡辺 五郎", "高橋 三郎", "鈴木 花子"].sort().join(), "検索：BP会社名で引ける（BP 3人）");
  await page.locator("#q").fill("上位商事");
  check((await rowsText(page)).join() === "鈴木 花子", "検索：上位会社でも引ける");
  await page.locator("#q").fill("顧客C");
  check((await rowsText(page)).join() === "佐藤 次郎", "検索：客先で引ける");
  await page.locator("#q").fill("該当なし");
  check((await page.locator("#empty").innerText()).includes("条件に合う案件はありません"), "0件のとき、条件をリセットできる案内が出る");
  await page.locator("#empty [data-reset]").click();
  check(await count() === 6 && (await page.locator("#q").inputValue()) === "", "案内のボタンでリセットできる");

  await page.locator("#fkind").selectOption("pp");
  check((await rowsText(page)).every((n) => ["田中 太郎", "佐藤 次郎", "小林 六郎"].includes(n)) && await count() === 3, "区分：PP だけ（未完了）");
  await page.locator("#fkind").selectOption("bp");
  check(await count() === 3, "区分：BP だけ");
  await page.locator("#reset").click();

  await page.locator("#fopen").uncheck();
  check(await count() === 7, "「未完了のみ」を外すと、完了も出る（7件）");
  await page.locator("#fopen").check();
  await page.locator("#fstage").selectOption("done");
  check((await rowsText(page)).join() === "伊藤 四郎" && !(await page.locator("#fopen").isChecked()), "選択肢「完了」→ 伊藤さん。未完了のみは自動で外れる");
  check((await page.locator("#count").innerText()).includes("7件中 1件"), "件数表示（7件中 1件を表示）");
  await page.locator("#sum .of-card[data-tag=\"all\"]").click();
  check(await count() === 7, "カード「対象案件」→ すべて表示");
  await page.close();
}

console.log("\n=== 月の切り替え ===");
{
  const { page, requests } = await open("/office/index.html?month=2026-09");
  await page.waitForSelector("#rows tr[data-id]");
  check((await page.locator("#sub").innerText()).includes("2026年9月分") && (await page.locator("#sub").innerText()).includes("10/5"), "2026年9月分・提出期限 10/5");
  await page.locator("#next").click();
  await page.waitForFunction(() => document.querySelector("#month").value === "2026-10");
  check(requests.office.at(-1) === "2026-10", "「次の月」で 2026-10 を読む");
  check((await page.locator("#empty").innerText()).includes("この月に動いている現場契約はありません"), "対象が無い月の案内");
  check((await page.locator("#today").innerText()).includes("この月に動いている案件はありません"), "今日やること：対象が無い月");
  check((await page.locator("#sum .of-card .v").first().innerText()) === "0", "対象 0 件");
  await page.locator("#prev").click();
  await page.waitForSelector("#rows tr[data-id]");
  check(requests.office.at(-1) === "2026-09", "「前の月」で戻る");
  await page.locator("#month").fill("2026-12");
  await page.waitForFunction(() => document.querySelector("#month").value === "2026-12");
  check(requests.office.at(-1) === "2026-12", "月の入力欄からも切り替えられる");
  await page.locator("#thisMonth").click();
  await page.waitForFunction((m) => document.querySelector("#month").value === m, jstMonth());
  check(requests.office.at(-1) === jstMonth(), "「今月」で今月（日本時間）へ");
  check(new URL(page.url()).searchParams.get("month") === jstMonth(), "URL に月が入る");
  await page.close();
}

console.log("\n=== 右ドロワー ===");
{
  const { page, requests } = await open("/office/index.html?month=2026-09");
  await page.waitForSelector("#rows tr[data-id]");
  await page.locator('#rows tr:has-text("田中 太郎") td[data-label="要員"]').click();
  await page.waitForSelector(".of-drawer");
  const head = await page.locator(".of-dr-head").innerText();
  check(head.includes("田中 太郎") && head.includes("PP") && head.includes("顧客A社") && head.includes("2026年9月"), "ドロワーの上部：氏名・区分・客先・対象月");
  const secNames = await page.locator(".of-sec h3").evaluateAll((h) => h.map((x) => x.lastChild.textContent.trim()));
  check(secNames.join("|") === "契約|勤務表|稼働計算|売上請求|発注|仕入請求|支払|履歴", `見出しの並び（いま ${secNames.join("|")}）`);
  const order = await page.locator(".of-sec").evaluateAll((s) => s.map((x) => x.id));
  check(order.join("|") === "dr-contract|dr-timesheet|dr-work|dr-sales|dr-order|dr-vendor|dr-payment|dr-history", `順番：契約→勤務表→稼働計算→売上請求→発注→仕入請求→支払→履歴（${order.join(",")}）`);
  check((await page.locator(".of-steps .st").count()) === 5, "進捗5行（勤務表・稼働・売上請求・仕入請求・支払）");
  check((await page.locator(".of-next").innerText()).includes("勤務表を確認して、稼働時間を確定してください"), "次にやること");
  const drText = await page.locator(".of-drawer").innerText();
  check(drText.includes("単価・精算条件は、この画面ではまだ扱いません") && !/\d{3},\d{3}|700000/.test(drText), "単価・精算条件は出さない");
  check(drText.includes("対象外です（売上のみの契約）"), "PP：仕入請求・支払は対象外");
  check(new URL(page.url()).searchParams.get("id") === "A", "URL に id が入る（開いた状態を再現できる）");

  await page.locator('.of-file button[data-file]').click();
  await page.waitForFunction(() => window.__opened.length > 0);
  check(requests.file[0] === F1, "提出ファイル：id で署名URLを取りに行く");
  check((await page.evaluate(() => window.__opened[0])) === "https://storage.example/x.pdf?token=t", "署名URLを開く");

  await page.keyboard.press("Escape");
  check(await page.locator(".of-drawer").count() === 0 && !new URL(page.url()).searchParams.get("id"), "Esc で閉じる（URLからも id が消える）");

  // 「要対応」ボタン → 該当の場所へ。低い画面（内容がスクロールしないと見えない）で、
  // 固定の見出し（氏名の帯）の下に隠れず、見える位置に来ること
  await page.setViewportSize({ width: 1400, height: 520 });
  await page.locator('#rows tr:has-text("佐藤 次郎") button[data-cta="drawer"]').click();
  await page.waitForSelector(".of-drawer");
  await page.waitForTimeout(400);
  const pos = await page.evaluate(() => {
    const r = document.querySelector("#dr-sales").getBoundingClientRect();
    const head = document.querySelector(".of-dr-head").getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), headBottom: Math.round(head.bottom), vh: innerHeight };
  });
  check(pos.top >= pos.headBottom - 1 && pos.bottom <= pos.vh,
    `「要対応」ボタン → 売上請求の欄が、氏名の帯に隠れず見える位置へ（欄 ${pos.top}〜${pos.bottom}px・帯の下端 ${pos.headBottom}px・画面 ${pos.vh}px）`);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.locator(".of-drawer-bg").click({ position: { x: 10, y: 300 } });
  check(await page.locator(".of-drawer").count() === 0, "背景を押しても閉じる");

  // BP：仕入請求・ファイル
  await page.locator('#rows tr:has-text("渡辺 五郎") td[data-label="要員"]').click();
  await page.waitForSelector(".of-drawer");
  const bpText = await page.locator("#dr-vendor").innerText();
  check(bpText.includes("株式会社ビーピー") && bpText.includes("受領済み") && bpText.includes("BP請求書.pdf"), "BP：仕入請求は受領済みで、請求書のファイルが見える");
  check((await page.locator("#dr-payment").innerText()).includes("支払の記録は、まだ使えません"), "BP：支払の表（db/117）が無いときは、まだ使えないと出す");
  check((await page.locator("#dr-history .of-tl .row").count()) === 5, "履歴：印を付けた日時が並ぶ");
  await page.keyboard.press("Escape");

  // 完了・要確認
  await page.goto(`${BASE}/office/index.html?month=2026-09&id=E`);
  await page.waitForSelector(".of-drawer");
  check((await page.locator(".of-next.ok").innerText()).includes("完了"), "完了の案件：完了と表示");
  check((await page.locator(".of-dr-head").innerText()).includes("伊藤 四郎"), "URL の id でドロワーが開いた状態を再現（完了は一覧に出ない行でも）");
  await page.goto(`${BASE}/office/index.html?month=2026-09&id=G`);
  await page.waitForSelector(".of-drawer");
  check((await page.locator(".of-drawer .of-banner").innerText()).includes("順番どおりについていません"), "要確認の理由がドロワーの上に出る");
  await page.goto(`${BASE}/office/index.html?month=2026-09&id=NOPE`);
  await page.waitForSelector("#rows tr[data-id]");
  check(await page.locator(".of-drawer").count() === 0 && !new URL(page.url()).searchParams.get("id"), "存在しない id は無視して、URL からも消す");
  await page.close();
}

console.log("\n=== キーボード ===");
{
  const { page } = await open("/office/index.html?month=2026-09");
  await page.waitForSelector("#rows tr[data-id]");
  const row = page.locator('#rows tr:has-text("田中 太郎")');
  await row.focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".of-drawer");
  check(await page.evaluate(() => document.activeElement?.classList.contains("of-drawer")), "開いたら、ドロワーへフォーカスが移る");
  await page.keyboard.press("Escape");
  check(await page.evaluate(() => document.activeElement?.matches?.("tr[data-id]") && document.activeElement.textContent.includes("田中")), "Esc で閉じると、元の行へフォーカスが戻る");
  await page.close();
}

console.log("\n=== 権限・MFA・エラー ===");
{
  const a = await open("/office/index.html", { access: { office: false, recruit: true, sell: false } });
  await a.page.waitForURL(/\/home\.html/);
  check(true, "Office 権限が無い人（HR だけ）は home.html へ送り返される");
  check(a.requests.office.length === 0, "その人のために、Office の API は呼ばない");
  await a.page.close();

  const b = await open("/office/index.html", { access: null });
  await b.page.waitForURL(/\/home\.html/);
  check(true, "access が無い（古い応答）ときは、入れない側に倒す");
  await b.page.close();

  const c = await open("/office/index.html", { loggedIn: false });
  await c.page.waitForURL(/\/index\.html/);
  check(true, "未ログインは index.html へ");
  await c.page.close();

  const d = await open("/office/index.html?month=2026-09", {
    officeResponse: () => ({ status: 403, body: { error: "mfa_required", hint: "登録してください", enrolled: false } }),
  });
  await d.page.waitForURL(/\/mypage\.html/);
  check(new URL(d.page.url()).pathname === "/mypage.html" && new URL(d.page.url()).hash === "#mfa", "（共通の遷移）サーバが mfa_required を返したら /mypage.html#mfa へ（/office/mypage.html にならない）");
  await d.page.close();

  const e = await open("/office/index.html?month=2026-09", {
    // API が返す形（空の一覧と同じ形＋理由）。summary が欠けると、画面は描けない
    officeResponse: (m) => ({ body: { ...build(m, "2026-10-06", []), accessNotReady: true, message: "権限の設定が未適用のため表示できません。db/100_office_access.sql の実行を依頼してください" } }),
  });
  await e.page.waitForSelector(".of-banner");
  check((await e.page.locator(".of-banner").innerText()).includes("db/100_office_access.sql"), "権限の設定が未適用なら、「0件」ではなく理由を出す");
  await e.page.close();

  const f = await open("/office/index.html?month=2026-09", {
    officeResponse: (m) => ({ body: { ...build(m, "2026-10-06", []), notReady: true, message: "この機能に必要なテーブルがまだ作られていません。管理者に db/076_site_contracts.sql の実行を依頼してください" } }),
  });
  await f.page.waitForSelector(".of-banner");
  check((await f.page.locator(".of-banner").innerText()).includes("db/076_site_contracts.sql"), "表が無い環境は、実行してほしい SQL を案内する");
  await f.page.close();

  const g = await open("/office/index.html?month=2026-09", {
    officeResponse: () => ({ status: 500, body: { error: "db_query_failed", detail: "boom" } }),
  });
  await g.page.waitForSelector(".of-banner.err");
  check((await g.page.locator(".of-banner.err").innerText()).includes("取得に失敗しました"), "取得に失敗したら、画面にそう出る（他は空にする）");
  check(await g.page.locator("#rows tr[data-id]").count() === 0, "失敗時に古い一覧を残さない");
  await g.page.close();
}

console.log("\n=== スマホ幅 ===");
{
  const { page, errs } = await open("/office/index.html?month=2026-09", { viewport: { width: 390, height: 844 } });
  await page.waitForSelector("#rows tr[data-id]");
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 1, `横にはみ出さない（はみ出し ${over}px）`);
  check(await page.locator(".of-table thead").evaluate((e) => getComputedStyle(e).display) === "none", "表はカードになる（見出し行を隠す）");
  check((await page.locator("#rows tr").first().locator('td[data-label="客先"]').evaluate((e) => getComputedStyle(e, "::before").content)).includes("客先"), "各項目に見出しが付く");
  const cards = await page.locator("#sum .of-card").evaluateAll((c) => c.map((x) => x.getBoundingClientRect().width));
  check(cards.every((w) => w > 100), "数字カードは2列で、潰れない");
  await page.locator('#rows tr:has-text("田中 太郎")').first().click();
  await page.waitForSelector(".of-drawer");
  const w = await page.locator(".of-drawer").evaluate((e) => Math.round(e.getBoundingClientRect().width));
  check(w <= 390, `ドロワーは画面幅に収まる（${w}px）`);
  check(errs.length === 0, `ブラウザのエラーが無い ${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 失敗` : "\nすべて通過");
process.exit(bad ? 1 : 0);
