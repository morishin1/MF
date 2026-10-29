// Copy only editable content into a new personal event. No source identity,
// completion state, history, attendees, or external-calendar link is carried over.
(function () {
  const DAY = 86400000;
  const categories = ["work", "meeting", "visit", "other"];
  const day = value => new Date(new Date(value).getTime() + 9 * 3600000).toISOString().slice(0, 10);
  const time = value => new Date(new Date(value).getTime() + 9 * 3600000).toISOString().slice(11, 16);
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  const stamp = (date, time) => Date.parse(`${date}T${time}:00+09:00`);

  function draft(event) {
    if (!event || event.source !== "self" || event.visibility !== "shared" || event.own === false || !categories.includes(event.category) ||
        !Number.isFinite(Date.parse(event.starts_at)) || !Number.isFinite(Date.parse(event.ends_at))) return null;
    return {
      title: event.title || "", body: event.body || "", location: event.location || "",
      category: event.category, allDay: !!event.all_day,
      startDate: day(event.starts_at), endDate: day(event.ends_at),
      startTime: time(event.starts_at), endTime: time(event.ends_at),
      quantity: window.CalendarQuantity.format(event.planned_quantity, event.planned_quantity_unit),
    };
  }

  function payload(values, { quantityAvailable = false } = {}) {
    const title = values.title.trim();
    if (!title) throw Error("業務内容を入力してください。");
    if (!validDate(values.startDate) || !validDate(values.endDate)) throw Error("開始日・終了日を確認してください。");
    if (!categories.includes(values.category)) throw Error("区分を選んでください。");
    // Internal all-day events include the end date (same convention as schedule.html).
    const start = values.allDay ? "00:00" : values.startTime;
    const end = values.allDay ? "23:59" : values.endTime;
    const validTime = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (!validTime(start) || !validTime(end)) throw Error("開始・終了時刻を確認してください。");
    const startsAt = `${values.startDate}T${start}:00+09:00`;
    const endsAt = `${values.endDate}T${end}:00+09:00`;
    const duration = Date.parse(endsAt) - Date.parse(startsAt);
    if (duration <= 0) throw Error("終了日時は開始日時より後にしてください。");
    if (duration > 366 * DAY) throw Error("1件で1年を超える予定は入れられません。");
    return { title, body: values.body.trim() || null, location: values.location.trim() || null,
      category: values.category, allDay: !!values.allDay, startsAt, endsAt, visibility: "shared",
      ...(quantityAvailable ? window.CalendarQuantity.parse(values.quantity) : {}) };
  }

  function init({ root, create, onSaved, onUncertain = () => {} }) {
    const field = name => root.querySelector(`[name="${name}"]`);
    const form = root.querySelector("form");
    const status = root.querySelector('[role="status"]');
    const save = root.querySelector('[type="submit"]');
    const controls = [...root.querySelectorAll("input, textarea, select, button")];
    let opened = false, saving = false, submitted = false, uncertain = false, returnFocus = null, overflow = "";
    let previousStart = NaN, originalStart = NaN, originalDate = "", quantityAvailable = false, hasSourceQuantity = false;
    const read = () => Object.fromEntries(["title", "body", "location", "category", "startDate", "endDate", "startTime", "endTime", "quantity"]
      .map(name => [name, field(name).value]).concat([["allDay", field("allDay").checked]]));
    function allDayChanged() {
      field("startTime").disabled = saving || field("allDay").checked;
      field("endTime").disabled = saving || field("allDay").checked;
      field("quantity").disabled = saving || !quantityAvailable;
    }
    function close() {
      if (saving || !opened) return;
      opened = false;
      root.hidden = true;
      form.reset();
      status.textContent = "";
      document.body.style.overflow = overflow;
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      returnFocus = null;
    }
    function open(event, options = {}) {
      if (saving || opened || uncertain) return false;
      const values = draft(event);
      if (!values) return false;
      opened = true; submitted = false;
      returnFocus = document.activeElement;
      overflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      controls.forEach(control => { control.disabled = false; });
      const details = root.querySelector("details");
      if (details) details.open = false;
      for (const [name, value] of Object.entries(values)) {
        if (name === "allDay") field(name).checked = value;
        else field(name).value = value;
      }
      quantityAvailable = options.quantityAvailable === true;
      hasSourceQuantity = event.planned_quantity != null || !!event.planned_quantity_unit;
      root.querySelector("#copy-quantity-note").textContent = quantityAvailable
        ? "数字は目標です。元の実績・完了状態は引き継ぎません。"
        : hasSourceQuantity ? "数字の保存を確認できないため保存できません。入力を残して、再読み込み後に確認してください。"
          : "数字の保存はまだ準備されていません。時間・内容だけで保存できます。";
      originalStart = previousStart = stamp(values.startDate, values.startTime);
      originalDate = values.startDate;
      status.textContent = "";
      save.textContent = "新しい予定として保存";
      allDayChanged();
      root.hidden = false;
      field("startDate").focus();
      return true;
    }
    field("allDay").addEventListener("change", () => { allDayChanged(); previousStart = stamp(field("startDate").value, field("startTime").value); });
    function moveStart() {
      const next = stamp(field("startDate").value, field("startTime").value);
      const end = stamp(field("endDate").value, field("endTime").value);
      if (Number.isFinite(next) && Number.isFinite(previousStart) && Number.isFinite(end)) {
        const shifted = end + next - previousStart;
        field("endDate").value = day(shifted);
        field("endTime").value = time(shifted);
      }
      // Clearing an input must not lose the last valid duration anchor.
      if (Number.isFinite(next)) previousStart = next;
    }
    field("startDate").addEventListener("change", moveStart);
    field("startTime").addEventListener("change", moveStart);
    // No history entry is added for the draft. Back/Forward and BFCache restore
    // discard an unsaved form instead of accidentally resubmitting it.
    window.addEventListener("popstate", close);
    window.addEventListener("pagehide", () => {
      if (saving) { uncertain = true; submitted = true; onUncertain(); }
      else close();
    });
    root.querySelectorAll("[data-duplicate-close]").forEach(button => button.addEventListener("click", close));
    root.addEventListener("click", event => { if (event.target === root) close(); });
    document.addEventListener("keydown", event => {
      if (!opened) return;
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key === "Tab") {
        const active = controls.filter(control => !control.disabled);
        const first = active[0], last = active[active.length - 1];
        if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
          event.preventDefault(); first?.focus();
        }
      }
    });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (!opened || saving || submitted) return;
      let values;
      try {
        const input = read();
        values = payload(input, { quantityAvailable });
        if (input.startDate === originalDate && (input.allDay || Date.parse(values.startsAt) === originalStart)) {
          throw Error("新しい開始日または時刻を選んでください。元の日時のままでは複製できません。");
        }
        if (!quantityAvailable && hasSourceQuantity) throw Error("元の数字を保存できるか確認できません。入力を残して、再読み込み後に確認してください。");
      }
      catch (error) { status.textContent = error.message; return; }
      saving = true;
      controls.forEach(control => { control.disabled = true; });
      status.textContent = "保存中です。完了するまでこの画面でお待ちください。";
      save.textContent = "保存中…";
      let saved = false;
      try {
        await create(values);
        saved = true;
        submitted = true; // A refresh failure must never allow another POST.
      } catch (error) {
        if ([400, 401, 403, 404, 409, 422].includes(Number(error?.status)) || error?.code === "calendar_quantity_unavailable" || error?.code === "calendar_read_unavailable") {
          status.textContent = "保存されていません。" + (error.status === 401 ? "ログインし直してからお試しください。" : error.status === 403 ? "予定を登録する権限を確認してください。" : error.hint || "入力内容を確認してください。");
        } else {
          status.textContent = "保存結果を確認できませんでした。閉じてページを再読み込みし、登録済みか確認してから再操作してください。";
          // A lost response may still have committed. Do not offer an automatic retry.
          submitted = true;
          uncertain = true;
          onUncertain();
        }
      } finally {
        saving = false;
        if (!submitted) { controls.forEach(control => { control.disabled = false; }); allDayChanged(); }
        root.querySelectorAll("[data-duplicate-close]").forEach(button => { button.disabled = false; });
        save.textContent = "新しい予定として保存";
      }
      if (!saved) return;
      close();
      try { await onSaved(values); }
      catch { /* Saving has completed. Refresh must not repeat the creation. */ }
    });
    return { open, close, isOpen: () => opened };
  }
  window.CalendarDuplicate = { draft, payload, init };
})();
