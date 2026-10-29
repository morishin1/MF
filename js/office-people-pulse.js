// Officeトップ用。既存の申請・日報週次APIを読み、要確認だけを小さく表示する。
// 人事・労務権限がない利用者には呼び出さない。
(function () {
  "use strict";
  const esc = (v) => window.OfficeLayout.esc(String(v ?? ""));
  const tile = (label, value, unit, note, href, warn) =>
    '<a class="oh-pulse-tile'+(warn && value > 0 ? ' warn':'')+'" href="'+esc(href)+'">'
    +'<span class="lb">'+esc(label)+'</span>'
    +'<b>'+(value == null ? '—' : esc(value))
    +'<small>'+esc(unit)+'</small></b>'
    +'<span class="note">'+esc(note)+'</span></a>';

  async function load() {
    const section = document.getElementById("peoplePulse");
    if (!section) return;
    section.hidden = false;
    const metrics = document.getElementById("peopleMetrics");
    const rows = document.getElementById("peopleRequests");
    const note = document.getElementById("peopleNote");
    metrics.textContent = "申請・日報・勤怠を読み込み中…";
    const settled = await Promise.allSettled([
      API.listRequests("pending"),
      API.nippoWeek(new Date(Date.now() + 9 * 3600000).toISOString().slice(0,10)),
    ]);
    const requests = settled[0].status === "fulfilled" ? settled[0].value.requests || [] : null;
    const kpi = settled[1].status === "fulfilled" ? settled[1].value.kpi : null;
    const awaitingOffice = requests?.filter((r) => r.status === "pending");
    const awaitingOwner = requests?.filter((r) => r.status === "pending_owner");
    const today = kpi?.today;
    metrics.innerHTML =
      tile("Office承認待ち", awaitingOffice?.length, "件", "休暇・稟議の申請", "/admin-requests.html", true)
      + tile("日報未提出", kpi?.missing, "件", "今週・昨日までの営業日", "/admin-nippo.html", true)
      + tile("勤怠要確認", kpi?.timeCheck, "件", "今週の打刻状況", "/admin-nippo.html", true)
      + tile("今日の日報", today?.submitted, today?.expected == null ? "人提出" : "/" + today.expected + "人",
        "今日の提出状況", "/admin-nippo.html#sec-today", false);
    // ホームに申請理由は出さず、名前・種別・承認段階だけを見せる。
    rows.innerHTML = (awaitingOffice || []).slice(0,3).map((r) =>
      '<a class="oh-request-row" href="/admin-requests.html">'
      +'<span><b>'+esc(r.applicant?.display_name || "申請者")+'</b>　'
      + (r.kind === "leave" ? "休暇申請" : "稟議申請")+'</span>'
      +'<span class="hint">Office承認待ち →</span></a>'
    ).join("");
    note.textContent = requests === null
      ? "申請を取得できませんでした。申請一覧から確認してください。"
      : (awaitingOwner?.length ? "KEIEI最終承認待ち：" + awaitingOwner.length + "件。 " : "")
        + (awaitingOffice.length > 3 ? "残りのOffice承認待ち：" + (awaitingOffice.length - 3) + "件は申請一覧にあります。" : "");
    if (!kpi) {
      note.textContent += " 日報・勤怠を取得できませんでした。詳細画面から確認してください。";
    }
  }
  window.OfficePeoplePulse = { load };
})();
