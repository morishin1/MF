// Optional calendar plan quantities. Never infer execution or completion from a plan.
export const CALENDAR_QUANTITY_COLUMNS = "planned_quantity,planned_quantity_unit";
const QUANTITY_KEYS = ["planned_quantity", "planned_quantity_unit"];

export function isCalendarQuantityMissing(error) {
  return ["42703", "PGRST204"].includes(error?.code)
    && /\bplanned_quantity(?:_unit)?\b/.test([error.message, error.details, error.hint].filter(Boolean).join(" "));
}

/** Read-only factory: each invocation must rebuild the same authorized filters.
 * Retry only missing optional columns, never permission/network/other schema errors.
 */
export async function readCalendarQuantity(makeQuery, baseColumns) {
  const run = async columns => {
    try { return await makeQuery(columns); }
    catch (error) { return { data: null, error }; }
  };
  const first = await run(`${baseColumns},${CALENDAR_QUANTITY_COLUMNS}`);
  if (!first.error) return { ...first, quantityAvailable: true };
  if (!isCalendarQuantityMissing(first.error)) return { ...first, quantityAvailable: false };
  return { ...await run(baseColumns), quantityAvailable: false };
}

/** Omitted fields stay omitted (PATCH must not clear an older client's values). */
export function normalizeCalendarQuantity(body) {
  const value = {};
  const has = key => Object.hasOwn(body || {}, key) && body[key] !== undefined;
  if (has("plannedQuantity")) {
    const raw = body.plannedQuantity;
    if (raw === null || (typeof raw === "string" && !raw.trim())) {
      value.planned_quantity = null;
      value.planned_quantity_unit = null;
    } else {
      const validType = typeof raw === "number" || (typeof raw === "string"
        && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim()));
      const number = validType ? Number(raw) : NaN;
      if (!Number.isFinite(number) || number < 0 || number > 1e9) {
        return { error: "invalid_planned_quantity", hint: "数字は0〜1,000,000,000の範囲で入力してください" };
      }
      value.planned_quantity = number;
    }
  }
  if (has("plannedQuantityUnit")) {
    const raw = body.plannedQuantityUnit;
    if (raw != null && typeof raw !== "string") return { error: "invalid_planned_quantity_unit", hint: "単位は10文字以内で入力してください" };
    const unit = (raw || "").trim();
    if ([...unit].length > 10) return { error: "invalid_planned_quantity_unit", hint: "単位は10文字以内で入力してください" };
    value.planned_quantity_unit = value.planned_quantity === null ? null : unit || null;
  }
  return { value };
}

export function hasCalendarQuantity(rows) {
  return rows.some(row => row.planned_quantity != null || Boolean(row.planned_quantity_unit));
}

// Safe only after a missing-column capability result: null means no value to store.
export function withoutCalendarQuantity(row) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !QUANTITY_KEYS.includes(key)));
}
