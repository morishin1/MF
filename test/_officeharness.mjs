// /api/office/* を、偽の Supabase（test/_memdb.mjs）と本物の権限判定で通すための共通の用意。
//
//   import する側は、先にこれを import する（モックを、API より先に張るため）。
//   判定関数（lib/gw.js の canAccessOffice、lib/mfa.js の requireMfa）は、モックせず本物を通す。
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
import { createMemDb } from "./_memdb.mjs";

const _HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(_HERE);
export const atRoot = (p) => _join(ROOT, p);

// ---- ID（UUID の形が要る） ---------------------------------------------------
export const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const T1 = uid(1), T2 = uid(2);
export const E_PP = uid(11), E_BP = uid(12), E_X = uid(13);
export const C_PP = uid(21), C_BP = uid(22), C_X = uid(23);
export const PC_1 = uid(31);

// ---- 表の定義（SQL と同じ制約） ------------------------------------------------
const isMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s));
const nowIso = () => new Date().toISOString();
const inSet = (v, set) => v === null || v === undefined || set.includes(v);
export const schema = {
  gw_billing_progress: {
    unique: [["employee_id", "billing_month", "site_contract_id"]],
    required: ["tenant_id", "employee_id", "site_contract_id", "billing_month"],
    defaults: () => ({ timesheet_received: false, work_confirmed: false, board_created: false, sent: false, bp_invoice_received: false,
      created_at: nowIso(), updated_at: nowIso() }),
  },
  gw_submissions: {
    required: ["tenant_id", "employee_id", "site_contract_id", "target_month", "kind", "file_name", "mime_type", "storage_path"],
    defaults: () => ({ submitted_at: nowIso(), source: "form", sha256: null, verified_at: null, uploaded_by: null }),
    check: (r) => (r.sha256 && !/^[0-9a-f]{64}$/.test(r.sha256) ? "sha256" : !inSet(r.source, ["form", "office"]) ? "source" : !inSet(r.kind, ["timesheet", "invoice"]) ? "kind" : null),
  },
  gw_office_events: {
    required: ["tenant_id", "billing_month", "kind"],
    defaults: () => ({ detail: {}, created_at: nowIso() }),
    check: (r) => (!/^[a-z][a-z_]*(\.[a-z][a-z_]*)*$/.test(r.kind) ? "kind" : !isMonth(r.billing_month) ? "billing_month" : null),
  },
  gw_site_contract_terms: {
    required: ["tenant_id", "site_contract_id", "valid_from", "pricing_type"],
    defaults: () => ({ prorate: false, created_at: nowIso(), updated_at: nowIso() }),
    check: (r) => {
      if (r.valid_to && r.valid_to < r.valid_from) return "valid_to";
      if (!["monthly", "hourly", "daily"].includes(r.pricing_type)) return "pricing_type";
      if (!inSet(r.settlement_mode, ["range", "fixed"])) return "settlement_mode";
      if (r.settle_min_minutes != null && r.settle_max_minutes != null && r.settle_min_minutes > r.settle_max_minutes) return "settle_range";
      if (!inSet(r.settle_unit_minutes, [5, 10, 15, 30, 60])) return "settle_unit";
      if (!inSet(r.rounding_mode, ["floor", "ceil", "round"]) || !inSet(r.amount_rounding, ["floor", "ceil", "round"])) return "rounding";
      if (!inSet(r.rounding_scope, ["day", "month"])) return "rounding_scope";
      for (const k of ["sales_unit_price", "purchase_unit_price", "over_rate_per_hour", "under_rate_per_hour"]) if (r[k] != null && r[k] < 0) return k;
      return null;
    },
  },
  gw_timesheets: {
    unique: [["employee_id", "target_month", "site_contract_id"]],
    required: ["tenant_id", "employee_id", "site_contract_id", "target_month", "status"],
    defaults: () => ({ status: "draft", read_state: "none", read_warnings: [], unresolved_count: 0, flagged_count: 0, spill_minutes: 0,
      carry_in_minutes: 0, review_seconds: 0, edit_count: 0, created_at: nowIso(), updated_at: nowIso() }),
    check: (r) => (!isMonth(r.target_month) ? "target_month" : !["draft", "confirmed", "returned"].includes(r.status) ? "status"
      : !["none", "ok", "failed"].includes(r.read_state) ? "read_state" : null),
  },
  gw_timesheet_days: {
    unique: [["timesheet_id", "work_date"]],
    required: ["tenant_id", "timesheet_id", "work_date"],
    defaults: () => ({ source: "ai", ai_flags: [], edited: false, reviewed_at: null, ai_snapshot: null, created_at: nowIso(), updated_at: nowIso() }),
    check: (r) => {
      if (!inSet(r.kind, ["work", "off"])) return "kind";
      if (r.start_min != null && !(r.start_min >= 0 && r.start_min < 1440)) return "start_min";
      if (r.end_min != null && !(r.end_min >= 0 && r.end_min < 2880)) return "end_min";
      if (r.break_min != null && !(r.break_min >= 0 && r.break_min <= 1440)) return "break_min";
      if (r.sheet_worked_min != null && !(r.sheet_worked_min >= 0 && r.sheet_worked_min <= 1440)) return "sheet_worked_min";
      if (!inSet(r.source, ["ai", "manual"]) || !inSet(r.ai_confidence, ["high", "mid", "low"])) return "source/confidence";
      return null;
    },
  },
};

// ---- RLS の再現（db/099・100・101〜103）-----------------------------------------
//   既存の4表は、既存ポリシー（is_tenant_staff＝会計の管理者）＋ db/100 の Office 権限の読み取り。
//   新しい4表は、Office 権限（経営者・責任者・経理）の読み取りだけ。名簿は会計の管理者だけ
const LEGACY = ["gw_site_contracts", "gw_billing_progress", "gw_submissions", "gw_partner_companies"];
const NEW = ["gw_office_events", "gw_site_contract_terms", "gw_timesheets", "gw_timesheet_days"];
const hasOfficeRole = (c) => ["owner", "manager", "finance"].some((r) => (c?.roles || []).includes(r));
export const rls = (name, c) => {
  if (LEGACY.includes(name)) return Boolean(c?.isAdmin) || hasOfficeRole(c);
  if (NEW.includes(name)) return hasOfficeRole(c);
  if (name === "gw_employees") return Boolean(c?.isAdmin);
  return true;
};

export const mem = createMemDb({ schema, rls });
export const ctl = { who: null, aal: "aal2" };
export const asked = [];        // userClient で読んだ列（機微な列を読んでいないかを見る）
export const logged = [];

const wrap = (client, asUser) => ({
  storage: client.storage,
  from: (n) => {
    const q = client.from(n);
    const sel = q.select.bind(q);
    q.select = (c, o) => { asked.push({ table: n, cols: c, asUser }); return sel(c, o); };
    return q;
  },
});
mock.module(atRoot("lib/supabase.js"), {
  namedExports: {
    admin: () => wrap(mem.admin(), false),
    userClient: () => wrap(mem.userClient(ctl.who), true),
  },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-1", factors: ctl.who?.factors || [] }), getMemberships: async () => [] },
});
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => ctl.who } });

// AI：本物の readTimesheet に、偽の Anthropic client を差し込む（検査・正規化は本物を通す）
export const ai = { reply: null, calls: [] };
const REAL_AI = await import(atRoot("lib/office-timesheet-ai.js"));
mock.module(atRoot("lib/office-timesheet-ai.js"), {
  namedExports: {
    ...REAL_AI,
    readTimesheet: (args) => REAL_AI.readTimesheet({
      ...args,
      client: { messages: { create: async (params, opts) => {
        ai.calls.push({ params, opts });
        if (ai.reply instanceof Error) throw ai.reply;
        return typeof ai.reply === "function" ? ai.reply(params) : ai.reply;
      } } },
    }),
  },
});

// ---- 人物 ---------------------------------------------------------------------
export const P = (roles, extra = {}) => ({ tenantId: T1, isAdmin: false, isHr: false, roles, employee: { id: uid(99), display_name: "経理 花子" }, ...extra });
export const OWNER = P(["owner"], { isHr: true });
export const MANAGER = P(["manager"]);
export const FINANCE = P(["finance"]);
export const DENIED = {
  "人事": P(["hr"], { isHr: true }),
  "営業担当": P(["sales"]),
  "採用担当": P(["recruiter"]),
  "IT・管理": P(["it"]),
  "社労士": P(["labor_advisor"]),
  "会計の管理者だけ": P([], { isAdmin: true, isHr: true }),
  "会計の管理者＋人事": P(["hr"], { isAdmin: true, isHr: true }),
  "一般メンバー": P([]),
};

const token = (aal) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64({ sub: "u-1", aal })}.sig`;
};
const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
export const call = async (handler, url, { aal = ctl.aal, method = "GET", body } = {}) => {
  const r = res();
  const raw = body === undefined ? undefined : JSON.stringify(body);
  await handler({
    method, url, headers: { authorization: `Bearer ${token(aal)}`, "content-type": "application/json" },
    // readJson が使う形（ストリームと、既に読んだ body の両方）に対応
    body,
    async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw); },
  }, r);
  return r;
};
