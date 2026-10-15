export const HR_MATERIAL_CATEGORIES = [
  { key: "company", label: "会社案内" },
  { key: "recruiting", label: "採用資料" },
  { key: "mugendojo", label: "無限道場" },
  { key: "service", label: "サービス" },
  { key: "regional", label: "地方創生" },
  { key: "ai_dx", label: "AI・DX" },
  { key: "other", label: "その他" },
];

export const HR_MATERIAL_KINDS = ["url", "file"];
export const HR_MATERIAL_MAX_BYTES = 10 * 1024 * 1024;
export const HR_MATERIAL_BUCKET = "hr";
export const HR_MATERIAL_FILE_MIME = "application/pdf";
export const HR_MATERIAL_FILE_ACCEPT = ".pdf,application/pdf";

export const materialCategoryLabel = (key) =>
  HR_MATERIAL_CATEGORIES.find((x) => x.key === key)?.label || key || "その他";

export function cleanMaterialName(v) {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, 160) : null;
}

export function cleanMaterialDescription(v) {
  const s = String(v ?? "").replace(/\r\n/g, "\n").trim();
  return s ? s.slice(0, 1000) : null;
}

export function isHttpsUrl(v) {
  try {
    const u = new URL(String(v || ""));
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeMaterialIds(ids) {
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids)) return null;
  const out = [...new Set(ids.map((x) => String(x || "").trim()).filter(Boolean))];
  return out.every((x) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x))
    ? out : null;
}

export function shapeHrMaterial(r) {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    categoryLabel: materialCategoryLabel(r.category),
    kind: r.kind,
    url: r.kind === "url" ? r.url : null,
    filename: r.filename || null,
    mimeType: r.mime_type || null,
    sizeBytes: r.size_bytes ?? null,
    description: r.description || null,
    sortOrder: r.sort_order ?? 100,
    active: r.is_active !== false,
    shareExternal: Boolean(r.share_external),
    defaultForCasual: Boolean(r.default_for_casual),
    createdAt: r.created_at || null,
    updatedAt: r.updated_at || null,
  };
}
