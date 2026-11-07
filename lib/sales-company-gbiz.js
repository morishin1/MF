// Optional official company-number enrichment. Corporate numbers MUST come from a
// linked ENGER company record; never infer one from company name alone.
export function normalizeLegalName(value) {
  return String(value || '').normalize('NFKC').replace(/株式会社|有限会社|合同会社/g,'')
    .replace(/[\s\u3000・.,，。\-‐－（）()]/g,'').toLowerCase();
}

export function sameCompanyName(left, right) {
  const a = normalizeLegalName(left), b = normalizeLegalName(right);
  return Boolean(a && b && a === b);
}

export async function fetchGbizCompany(corporateNumber, token = process.env.GBIZINFO_API_TOKEN || process.env.GBIZINFO_TOKEN) {
  if (!/^\d{13}$/.test(String(corporateNumber || '')) || !token) return null;
  const sourceUrl = 'https://api.info.gbiz.go.jp/hojin/v2/hojin/' + corporateNumber;
  try {
    const res = await fetch(sourceUrl, {
      redirect:'error',
      headers:{'X-hojinInfo-api-token':token,Accept:'application/json'},
      signal:AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    if (Number(res.headers.get('content-length')||0) > 150000) return null;
    const raw = await res.text();
    if (raw.length > 150000) return null;
    const payload = JSON.parse(raw);
    const info = payload?.['hojin-infos']?.[0];
    if (!info || typeof info !== 'object') return null;
    return {
      corporateNumber,
      name:String(info.name || '').slice(0,200),
      location:String(info.location || '').slice(0,300),
      businessSummary:String(info.business_summary || '').slice(0,600),
      employeeNumber:info.employee_number == null ? null : String(info.employee_number).slice(0,40),
      capitalStock:info.capital_stock == null ? null : String(info.capital_stock).slice(0,40),
      establishmentDate:String(info.date_of_establishment || '').slice(0,40),
      sourceUrl, checkedAt:new Date().toISOString()
    };
  } catch { return null; }
}
