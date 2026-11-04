// ENGER企業マスターは株式会社エイト社内営業の情報。
// 現在のSupabase tenantsから確認した正規テナントIDのみ許可する。
// canSell(ctx) に加え、テナントの一致も必須（将来別の企業がGWを使っても非公開）。
const EIGHT_ENGER_SALES_TENANT="4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac";
export const canAccessEightEngerDirectory = ctx => Boolean(
  ctx?.tenantId && ctx.tenantId === EIGHT_ENGER_SALES_TENANT
);
