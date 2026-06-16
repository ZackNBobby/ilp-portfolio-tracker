// Vercel serverless function — fetches S&P 500 (^GSPC) historical daily prices.
// Used to overlay benchmark performance on the Portfolio Growth Over Time chart.
// Query: ?from=YYYY-MM-DD  (the client's policy start date)

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "application/json, */*",
};

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  // Cache 6 hours — S&P 500 updates during US market hours
  res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=43200");

  const from = (req.query.from || "").trim();
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    return res.status(400).json({ error: "Missing or invalid ?from=YYYY-MM-DD parameter" });
  }

  const fromDate = new Date(from + "T00:00:00Z");
  const nowDate  = new Date();
  const period1  = Math.floor(fromDate.getTime() / 1000);
  const period2  = Math.floor(nowDate.getTime() / 1000);

  // Go back a few extra days in case from date falls on a weekend/holiday
  const buffer   = 5 * 24 * 60 * 60; // 5 days
  const p1       = period1 - buffer;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC`
    + `?interval=1d&period1=${p1}&period2=${period2}&events=history`;

  try {
    const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (!r.ok) {
      // Try backup URL format
      throw new Error(`Yahoo Finance returned HTTP ${r.status}`);
    }
    const data = await r.json();

    const chart = data?.chart?.result?.[0];
    if (!chart) throw new Error("No data returned from Yahoo Finance");

    const timestamps = chart.timestamp || [];
    const closes     = chart.indicators?.quote?.[0]?.close || [];

    if (!timestamps.length) throw new Error("Empty price series from Yahoo Finance");

    // Build [{date, price}] array, oldest first, skipping nulls
    const prices = [];
    for (let i = 0; i < timestamps.length; i++) {
      const price = closes[i];
      if (price == null || isNaN(price)) continue;
      const d = new Date(timestamps[i] * 1000);
      const yyyy = d.getUTCFullYear();
      const mm   = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd   = String(d.getUTCDate()).padStart(2, "0");
      prices.push({ date: `${yyyy}-${mm}-${dd}`, price: +price.toFixed(2) });
    }

    if (!prices.length) throw new Error("No valid price points after filtering");

    // Filter to dates >= from (the buffer window may include earlier dates)
    const filtered = prices.filter(p => p.date >= from);

    return res.status(200).json({
      symbol: "^GSPC",
      from,
      count: filtered.length,
      prices: filtered,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(503).json({ error: e.message });
  }
};
