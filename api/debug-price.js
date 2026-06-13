// Test Income's live price API with every date format and HTTP method combination

const H = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "application/json, */*",
  "Accept-Language": "en-SG,en-GB;q=0.9,en;q=0.8",
  "Referer": "https://www.income.com.sg/funds/income-global-dynamic-bond-fund",
  "Origin": "https://www.income.com.sg",
};

const BASE = "https://www.income.com.sg/api/fund-prices/custom-range";
const FUND = "income-global-dynamic-bond-fund";

// Date helpers
const pad = n => String(n).padStart(2, "0");
const d = new Date();
const y = d.getFullYear(), mo = d.getMonth() + 1, dy = d.getDate();
// Use last Friday if today is weekend
const lastBizDay = new Date(d);
while ([0,6].includes(lastBizDay.getDay())) lastBizDay.setDate(lastBizDay.getDate() - 1);
const lby = lastBizDay.getFullYear(), lbm = lastBizDay.getMonth()+1, lbd = lastBizDay.getDate();

const dates = {
  iso_today:    { start_date: `${y}-${pad(mo-1||12)}-${pad(dy)}`, end_date: `${y}-${pad(mo)}-${pad(dy)}` },
  iso_biz:      { start_date: `${lby}-${pad(lbm-1||12)}-${pad(lbd)}`, end_date: `${lby}-${pad(lbm)}-${pad(lbd)}` },
  dmy_today:    { start_date: `${pad(dy)}/${pad(mo-1||12)}/${y}`, end_date: `${pad(dy)}/${pad(mo)}/${y}` },
  dmy_biz:      { start_date: `${pad(lbd)}/${pad(lbm-1||12)}/${lby}`, end_date: `${pad(lbd)}/${pad(lbm)}/${lby}` },
  ymd_slash:    { start_date: `${y}/${pad(mo-1||12)}/${pad(dy)}`, end_date: `${y}/${pad(mo)}/${pad(dy)}` },
  wide_iso:     { start_date: `${y}-01-01`, end_date: `${lby}-${pad(lbm)}-${pad(lbd)}` },
  wide_dmy:     { start_date: `01/01/${y}`, end_date: `${pad(lbd)}/${pad(lbm)}/${lby}` },
};

async function tryCall(label, method, body, queryParams) {
  try {
    const url = queryParams ? `${BASE}?${new URLSearchParams({fund_code: FUND, ...queryParams})}` : BASE;
    const opts = {
      method,
      headers: method === "POST" ? {...H, "Content-Type": "application/json"} : H,
      signal: AbortSignal.timeout(8000),
    };
    if (method === "POST" && body) opts.body = JSON.stringify({fund_code: FUND, ...body});
    const r = await fetch(url, opts);
    const text = await r.text();
    return { status: r.status, ok: r.ok, preview: text.slice(0, 400) };
  } catch(e) { return { error: e.message }; }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const results = {};

  for (const [label, d] of Object.entries(dates)) {
    results[`GET_${label}`]  = await tryCall(label, "GET",  null, d);
    results[`POST_${label}`] = await tryCall(label, "POST", d,    null);
  }

  // Also try with no dates at all — maybe it returns latest price by default
  results["GET_no_dates"]  = await tryCall("no_dates", "GET",  null, {});
  results["POST_no_dates"] = await tryCall("no_dates", "POST", {},   null);

  res.status(200).json(results);
};
