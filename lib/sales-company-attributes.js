// Shared Sales fields stored on the canonical enger.companies row.
export const SALES_STATUS_VALUES = ["新規", "既存", "打ち合わせ済", "その他"];
export const SALES_STATUS_LABELS = { "打ち合わせ済": "打ち合わせ済み" };
export const COMPANY_ROLES = ["end_client", "prime_sier", "ses", "bp", "ses_job", "dev_partner", "other"];
export const COMPANY_ROLE_LABELS = {
  end_client: "エンド企業",
  prime_sier: "受託会社",
  ses: "SES（両面）",
  bp: "SES（人材側紹介のみ）",
  ses_job: "SES（案件側紹介のみ）",
  dev_partner: "開発パートナー",
  other: "その他",
};
export const DISPATCH_LICENSE_TAG = "flag:dispatch_license";

const rolePrefix = "role:";
const roleTag = (role) => `${rolePrefix}${role}`;

export function rolesFromTags(tags) {
  const values = new Set((Array.isArray(tags) ? tags : []).map((tag) => String(tag ?? "").trim()));
  return COMPANY_ROLES.filter((role) => values.has(roleTag(role)));
}

export function hasDispatchLicense(tags) {
  return (Array.isArray(tags) ? tags : []).some((tag) => String(tag ?? "").trim() === DISPATCH_LICENSE_TAG);
}

export function tagsWithRoles(tags, roles) {
  const kept = (Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag ?? "").trim())
    .filter((tag) => tag && !tag.startsWith(rolePrefix));
  const next = COMPANY_ROLES.filter((role) => roles.includes(role)).map(roleTag);
  return [...new Set([...kept, ...next])];
}

export function tagsWithDispatchLicense(tags, enabled) {
  const kept = (Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag ?? "").trim())
    .filter((tag) => tag && tag !== DISPATCH_LICENSE_TAG);
  return enabled ? [...new Set([...kept, DISPATCH_LICENSE_TAG])] : kept;
}

export function salesAttributesInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("営業状況の入力を確認してください。");
  const keys = Object.keys(raw);
  if (!keys.length || keys.length > 3 || keys.some((key) => !["status", "roles", "dispatchLicense"].includes(key))) {
    throw Error("営業状況の入力を確認してください。");
  }
  const out = {};
  if (Object.hasOwn(raw, "status")) {
    if (typeof raw.status !== "string" || !SALES_STATUS_VALUES.includes(raw.status)) throw Error("営業ステータスを候補から選択してください。");
    out.status = raw.status;
  }
  if (Object.hasOwn(raw, "roles")) {
    if (!Array.isArray(raw.roles) || raw.roles.length > COMPANY_ROLES.length ||
      raw.roles.some((role) => typeof role !== "string" || !COMPANY_ROLES.includes(role)) ||
      new Set(raw.roles).size !== raw.roles.length) throw Error("企業ロールの選択内容を確認してください。");
    out.roles = [...raw.roles];
  }
  if (Object.hasOwn(raw, "dispatchLicense")) {
    if (typeof raw.dispatchLicense !== "boolean") throw Error("派遣事業許可の選択内容を確認してください。");
    out.dispatchLicense = raw.dispatchLicense;
  }
  return out;
}

export function salesAttributePatch(raw, currentTags) {
  const input = salesAttributesInput(raw);
  const patch = {};
  if (Object.hasOwn(input, "status")) patch.status = input.status;
  if (Object.hasOwn(input, "roles") || Object.hasOwn(input, "dispatchLicense")) {
    const roles = Object.hasOwn(input, "roles") ? input.roles : rolesFromTags(currentTags);
    const dispatchLicense = Object.hasOwn(input, "dispatchLicense") ? input.dispatchLicense : hasDispatchLicense(currentTags);
    patch.tags = tagsWithDispatchLicense(tagsWithRoles(currentTags, roles), dispatchLicense);
  }
  return patch;
}
