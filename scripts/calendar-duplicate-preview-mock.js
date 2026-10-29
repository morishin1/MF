// Preview-only replacement for authentication and API. No network or persistence.
(function () {
  const local = new Date();
  const date = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
  const plus = days => new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);
  const at = (date, time) => `${date}T${time}:00+09:00`;
  const events = [
    { id: "demo-routine", planned_quantity: 10, planned_quantity_unit: "件", title: "【サンプル】週次の資料確認", body: "複製すると、このメモも引き継がれます。実際の業務情報は入力しないでください。", location: "会議室A（架空）", category: "work", source: "self", visibility: "shared", all_day: false, starts_at: at(date, "09:00"), ends_at: at(date, "10:00") },
    { id: "demo-all-day", title: "【サンプル】3日間の研修", body: "終日・複数日の確認用です。", location: "オンライン（架空）", category: "meeting", source: "self", visibility: "shared", all_day: true, starts_at: at(date, "00:00"), ends_at: at(plus(2), "23:59") },
    { id: "demo-overnight", title: "【サンプル】日をまたぐ確認作業", body: "開始日を変えると終了日も同じ日数だけ移動します。", location: "作業室（架空）", category: "other", source: "self", visibility: "shared", all_day: false, starts_at: at(date, "23:00"), ends_at: at(plus(1), "01:00") },
  ];
  let next = 1;
  const clone = value => JSON.parse(JSON.stringify(value));
  function row(values, id) {
    return { id, title: values.title, body: values.body || null, location: values.location || null,
      category: values.category || "work", source: "self", visibility: "shared", all_day: !!values.allDay,
      starts_at: values.startsAt, ends_at: values.endsAt, planned_quantity: values.plannedQuantity, planned_quantity_unit: values.plannedQuantityUnit };
  }
  async function createEvent(values) {
    const event = row(values, "demo-copy-" + next++);
    events.push(event);
    return { event: clone(event) };
  }
  window.KPLayout = {
    esc: value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]),
    init: async () => ({ gw: { employee: { id: "demo-self" } } }),
  };
  window.API = {
    schedule: async (from, to) => ({ quantityAvailable: true, events: clone(events.filter(event => Date.parse(event.starts_at) >= Date.parse(from) && Date.parse(event.starts_at) < Date.parse(to))) }),
    teamSchedule: async () => ({ people: [{ id: "demo-self", name: "自分（サンプル）" }, { id: "demo-other", name: "メンバーA（サンプル）" }],
      events: [{ id: "demo-other-event", title: "【サンプル】他のメンバーの予定", location: "会議室B（架空）", category: "meeting", employeeId: "demo-other", employeeName: "メンバーA（サンプル）", allDay: false, startsAt: at(date, "11:00"), endsAt: at(date, "12:00") }] }),
    createEvent,
    updateEvent: async values => {
      const index = events.findIndex(event => event.id === values.id);
      if (index < 0) throw Error("サンプルの予定がありません");
      events[index] = { ...events[index], ...row(values, values.id) };
      return { event: clone(events[index]) };
    },
    deleteEvent: async id => { const index = events.findIndex(event => event.id === id); if (index >= 0) events.splice(index, 1); return { ok: true }; },
    api: async (path, options) => {
      if (path === "/api/schedule" && options?.body?.action === "batch_create") {
        const results = await Promise.all(options.body.events.map(createEvent));
        return { count: results.length, events: results.map(result => result.event) };
      }
      if (path === "/api/schedule/review") return { ai: false, verdict: "good", summary: "確認用の表示例です。AIへの通信・分析は行っていません。", details: "すべて架空のデータです。", metrics: { totalMinutes: 60, overlaps: 0 }, suggestions: [] };
      throw Error("この操作は確認版では利用できません");
    },
  };
})();
