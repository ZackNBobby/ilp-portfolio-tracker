// Final debug: call the discovered /api/fund-prices/custom-range endpoint
// and find fund codes from page HTML

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "application/json, */*",
  "Accept-Language": "en-SG,en-GB;q=0.9,en;q=0.8",
  "Referer": "https://www.income.com.sg/",
};

const SLUGS = [
  "income-global-dynamic-bond-fund",
  "income-global-absolute-alpha-fund",
  "income-india-equity-fund",
];

async function getFundCode(slug) {
  const r = await fetch(`https://www.income.com.sg/funds/${slug}`, {
    headers: { ...HEADERS, Accept: "text/html" }, signal: AbortSignal.timeout(10000),
  });
  const html = await r.text();
  // Look for fund_code in data attrs, JSON config blobs, or widget init
  const patterns = [
    /fund[_-]?code["'\s:=]+["']([A-Z0-9_\-]+)["']/i,
    /fundCode["'\s:=]+["']([A-Z0-9_\-]+)["']/i,
    /"fund_code"\s*:\s*"([^"]+)"/i,
    /data-fund-?code=["']([^"']+)["']/i,
    /data-code=["']([^"']+)["']/i,
    /"code"\s*:\s*"([A-Z0-9_\-]{2,20})"/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1];
  }
  // Last resort: find any short uppercase code near fund name
  const nameMatch = html.match(/"fundCode":"([^"]+)"/i) || html.match(/fundCode=([A-Z0-9]+)/i);
  return nameMatch ? nameMatch[1] : null;
}

async function tryApi(fundCode, from, to) {
  const base = "https://www.income.com.sg/api/fund-prices/custom-range";
  const attempts = [
    `${base}?fund_code=${fundCode}&from=${from}&to=${to}`,
    `${base}?fund_code=${fundCode}`,
    `${base}?fundCode=${fundCode}&from=${from}&to=${to}`,
    `${base}?code=${fundCode}&from=${from}&to=${to}`,
  ];
  const results = [];
  for (const url of attempts) {
    try {
      const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
      const text = await r.text();
      results.push({ url, status: r.status, preview: text.slice(0, 300) });
      if (r.ok) break;
    } catch (e) {
      results.push({ url, error: e.message });
    }
  }
  return results;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  const out = {};
  for (const slug of SLUGS) {
    const code = await getFundCode(slug);
    // Try slug itself as code if no code found in page
    const tryCode = code || slug;
    out[slug] = { detectedCode: code, apiAttempts: await tryApi(tryCode, weekAgo, today) };
  }

  // Also try calling the API with no params to see if it lists all funds
  try {
    const r = await fetch("https://www.income.com.sg/api/fund-prices/custom-range", {
      headers: HEADERS, signal: AbortSignal.timeout(8000),
    });
    out._noParams = { status: r.status, preview: (await r.text()).slice(0, 500) };
  } catch (e) { out._noParams = { error: e.message }; }

  res.status(200).json(out);
};
