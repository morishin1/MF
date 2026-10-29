// 全員の営業記録を横断するため、Sales利用権限とSales管理権限の両方を要求する。
import { canSell } from "./gw.js";
import { canManageProposals } from "./sales-proposals.js";

export const canViewBusinessReport = (ctx) => canSell(ctx) && canManageProposals(ctx);
