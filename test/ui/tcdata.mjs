// タイムカードの2画面を、APIだけ差し替えて実際に描く。


const me = {
  email: "zimu@8grp.co.jp",
  gw: {
    employee: { id: "emp-1", display_name: "今福 太郎", email: "taro@gw.8grp.co.jp",
                department: "制作部", position: "主任", joined_on: "2026-04-01", status: "active" },
    roles: ["hr"], isAdmin: true, tenantId: "t1", stage: null,
  },
  appRole: "admin", shows: {},
};

// 出勤中・休憩を挟んだ日・欠勤・直された日 をそろえる
const D = (d, h, m) => `2026-09-${String(d).padStart(2, "0")}T${String(h - 9).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
const entry = (d, o = {}) => ({
  id: `e${d}`, workDate: `2026-09-${String(d).padStart(2, "0")}`,
  clockIn: D(d, 9, 2), clockOut: D(d, 18, 5),
  breaks: [{ start: D(d, 12, 0), end: D(d, 13, 0) }],
  status: "closed", source: "self", note: null,
  editedAt: null, editReason: null, lockedAt: null,
  stayMinutes: 543, breakMinutes: 60, workMinutes: 483, open: false, onBreak: false,
  ...o,
});

const TODAY = entry(7, {
  clockOut: null, status: "open", stayMinutes: 121, breakMinutes: 0, workMinutes: 121,
  open: true, onBreak: false,
});

const MY = {
  month: "2026-09",
  today: TODAY,
  can: { in: false, out: true, break: true, resume: false },
  entries: [
    TODAY,
    entry(4, { editedAt: "2026-09-05T01:00:00Z", editReason: "退勤の打刻漏れ（18:00 を確認）", source: "admin" }),
    entry(3),
    entry(2, { status: "absent", clockIn: null, clockOut: null, breaks: [],
               stayMinutes: 0, breakMinutes: 0, workMinutes: 0, open: false, note: "有給休暇" }),
    entry(1, { lockedAt: "2026-09-01T00:00:00Z" }),
  ],
  totals: { days: 4, workMinutes: 1570, breakMinutes: 180, overMinutes: 45, openDays: 1 },
  scheduledMinutes: 480,
  fixes: [
    { id: "f1", work_date: "2026-09-04", want: { clockOut: D(4, 18, 0) },
      reason: "退勤を押し忘れました", status: "approved",
      decided_at: "2026-09-05T01:00:00Z", decided_note: "確認しました", created_at: "2026-09-04T23:00:00Z" },
    { id: "f2", work_date: "2026-09-05", want: { clockIn: D(5, 9, 0) },
      reason: "出勤の打刻が2分ずれています", status: "pending",
      decided_at: null, decided_note: null, created_at: "2026-09-06T01:00:00Z" },
  ],
  me: { name: "今福 太郎" },
};

const member = (id, name, dept, entries, totals, today, locked = false) => ({
  employee: { id, name, department: dept, status: "active" },
  scheduledMinutes: 480, totals, today, entries, locked,
});

const HANAKO = entry(7, {
  id: "h7", clockOut: null, status: "open", open: true, onBreak: true,
  breaks: [{ start: D(7, 12, 0), end: null }], stayMinutes: 121, breakMinutes: 20, workMinutes: 101,
});

const ADMIN = {
  month: "2026-09",
  members: [
    member("emp-1", "今福 太郎", "制作部", MY.entries,
      { days: 4, workMinutes: 1570, breakMinutes: 180, overMinutes: 45, openDays: 1 }, TODAY),
    member("emp-2", "鈴木 花子", "営業部", [HANAKO, entry(3, { id: "h3" })],
      { days: 2, workMinutes: 584, breakMinutes: 80, overMinutes: 3, openDays: 1 }, HANAKO),
    member("emp-3", "田中 一郎", "管理部", [],
      { days: 0, workMinutes: 0, breakMinutes: 0, overMinutes: 0, openDays: 0 }, null),
  ],
  fixes: [
    { id: "f2", employee_id: "emp-1", employeeName: "今福 太郎",
      work_date: "2026-09-05", reason: "出勤の打刻が2分ずれています。9:00 に来ています",
      want: { clockIn: D(5, 9, 0), clockOut: D(5, 18, 0), breaks: [{ start: D(5, 12, 0), end: D(5, 13, 0) }], status: "closed" },
      before: { clockIn: D(5, 9, 2), clockOut: D(5, 18, 0), breaks: [], status: "closed" },
      status: "pending", created_at: "2026-09-06T01:00:00Z" },
  ],
  working: [
    { name: "今福 太郎", since: D(7, 9, 2), onBreak: false },
    { name: "鈴木 花子", since: D(7, 9, 10), onBreak: true },
  ],
};

const ROUTES = [
  [/\/api\/me\b/, { ...me }],
  [/\/api\/public-config/, {}],
  [/\/api\/notifications/, { notifications: [], unread: 0 }],
  [/\/api\/timecard\/me/, MY],
  [/\/api\/timecard/, ADMIN],
];

export { ROUTES, me };