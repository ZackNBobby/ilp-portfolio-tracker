// Vercel serverless function — fetches 6 years of S&P 500 (^GSPC) daily closing prices.
// Always returns the full dataset; the client filters by each client's start date.
// This means only ONE fetch is ever needed regardless of how many clients you have.

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "application/json, */*",
};

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  // Cache 6 hours on Vercel CDN — S&P 500 updates once per trading day
  res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=43200");

  // Always fetch 6 years back so all clients are covered in one request
  const now      = new Date();
  const sixYears = new Date(now);
  sixYears.setFullYear(sixYears.getFullYear() - 6);
  const period1  = Math.floor(sixYears.getTime() / 1000);
  const period2  = Math.floor(now.getTime() / 1000);

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC`
    + `?interval=1d&period1=${period1}&period2=${period2}&events=history`;

  try {
    const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error(`Yahoo Finance returned HTTP ${r.status}`);

    const data = await r.json();
    const chart = data?.chart?.result?.[0];
    if (!chart) throw new Error("No data returned from Yahoo Finance");

    const timestamps = chart.timestamp || [];
    const closes     = chart.indicators?.quote?.[0]?.close || [];
    if (!timestamps.length) throw new Error("Empty price series from Yahoo Finance");

    const prices = [];
    for (let i = 0; i < timestamps.length; i++) {
      const price = closes[i];
      if (price == null || isNaN(price)) continue;
      const d    = new Date(timestamps[i] * 1000);
      const yyyy = d.getUTCFullYear();
      const mm   = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd   = String(d.getUTCDate()).padStart(2, "0");
      prices.push({ date: `${yyyy}-${mm}-${dd}`, price: +price.toFixed(2) });
    }

    if (!prices.length) throw new Error("No valid price points after filtering");

    return res.status(200).json({
      symbol: "^GSPC",
      from: prices[0]?.date,
      to:   prices[prices.length - 1]?.date,
      count: prices.length,
      prices,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(503).json({ error: e.message });
  }
};
