// Debug endpoint — probes multiple Income URL patterns to find live price API.
// Usage: /api/debug-price (tests dynamic bond fund by default)

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-SG,en-GB;q=0.9,en;q=0.8",
  "Referer": "https://www.income.com.sg/",
  "Cache-Control": "no-cache",
};
const HEADERS_JSON = { ...HEADERS, "Accept": "application/json, */*" };

async function probe(url, json = false) {
  try {
    const r = await fetch(url, {
      headers: json ? HEADERS_JSON : HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    const text = await r.text();
    return {
      status: r.status,
      ok: r.ok,
      contentType: r.headers.get("content-type"),
      // Return first 1000 chars to keep response readable
      preview: text.slice(0, 1000),
      length: text.length,
    };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const slug = "income-global-dynamic-bond-fund";
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const todaySG = new Date().toLocaleDateString("en-SG", { day:"2-digit", month:"2-digit", year:"numeric" }).replace(/\//g, "-"); // DD-MM-YYYY

  const results = {};

  // ── Income: try alternative price page URLs ──
  results["income_current_prices"] = await probe(`https://www.income.com.sg/funds/current-prices`);
  results["income_unit_prices"]    = await probe(`https://www.income.com.sg/funds/unit-prices`);
  results["income_historical_today_iso"] = await probe(`https://www.income.com.sg/funds/historical-prices?date=${today}`);
  results["income_historical_today_sg"]  = await probe(`https://www.income.com.sg/funds/historical-prices?date=${todaySG}`);
  results["income_historical_json"] = await probe(`https://www.income.com.sg/funds/historical-prices`, true);

  // ── Income: try internal API endpoint patterns ──
  results["income_api_v1_fund"]      = await probe(`https://www.income.com.sg/api/v1/funds/${slug}`, true);
  results["income_api_fund"]         = await probe(`https://www.income.com.sg/api/funds/${slug}`, true);
  results["income_api_fund_price"]   = await probe(`https://www.income.com.sg/api/funds/${slug}/price`, true);
  results["income_api_fund_prices"]  = await probe(`https://www.income.com.sg/api/fund-prices`, true);
  results["income_api_prices"]       = await probe(`https://www.income.com.sg/api/prices`, true);
  results["income_contentful_hint"]  = await probe(`https://www.income.com.sg/funds/${slug}`, false);

  // ── Check if fund page has any API URLs embedded in its JS ──
  try {
    const r = await fetch(`https://www.income.com.sg/funds/${slug}`, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
    const html = await r.text();
    // Find any /api/ paths referenced in the page HTML or inline scripts
    const apiRefs = [...html.matchAll(/["'`](\/api\/[^"'`\s]{3,60})["'`]/g)].map(m => m[1]);
    const fetchUrls = [...html.matchAll(/fetch\s*\(\s*["'`]([^"'`]+)["'`]/g)].map(m => m[1]).filter(u => u.includes("income") || u.startsWith("/"));
    results["income_page_api_refs"] = { apiRefs: [...new Set(apiRefs)].slice(0, 20), fetchUrls: [...new Set(fetchUrls)].slice(0, 20) };
  } catch (e) {
    results["income_page_api_refs"] = { error: e.message };
  }

  // ── Try Morningstar Singapore ──
  results["morningstar_search"] = await probe(`https://www.morningstar.com.sg/sg/funds/default.aspx`);

  // ── Try FSMOne (iFAST) ──
  results["fsmone_search"] = await probe(`https://www.fsmone.com.sg/funds/search?q=income+global+dynamic+bond`);

  res.status(200).json(results);
};
