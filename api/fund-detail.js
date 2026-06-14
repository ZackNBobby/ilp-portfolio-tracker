// Vercel serverless function — fetches full price history for one Income ILP fund.
// Used for the fund detail modal: performance %, price chart, oldest date available.

const FUND_SLUGS = {
  "Income Global Absolute Alpha Fund":          "income-global-absolute-alpha-fund",
  "Income Global Artificial Intelligence":      "income-global-artificial-intelligence",
  "Income Global Dynamic Bond Fund":            "income-global-dynamic-bond-fund",
  "Income Global Emerging Markets Equity Fund": "income-global-emerging-markets-equity-fund",
  "Income Global Gold Equity Fund":             "income-global-gold-equity-fund",
  "Income Global Growth Equity Fund":           "income-global-growth-equity-fund",
  "Income Global Sustainable Fund":             "income-global-sustainable-fund",
  "Income Global Technology Fund":              "income-global-technology-fund",
  "Income India Equity Fund":                   "income-india-equity-fund",
  "Income Regional China Fund":                 "income-regional-china-fund",
  "Income US Large Cap Equity Fund":            "income-us-large-cap-equity-fund",
  "Income World Healthscience Fund":            "income-world-healthscience-fund",
  "Money Market Fund":                          "money-market-fund",
  "Takaful Fund":                               "takaful-fund",
};

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,*/*",
  "Accept-Language": "en-SG,en-GB;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
};

function parseDMY(dmy) {
  const [d, m, y] = dmy.split("/");
  return new Date(`${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`);
}

function extractAllPrices(html) {
  const decoded = html.replace(/&quot;/g, '"');
  const entries = [];
  const re = /"day"\s*:\s*"(\d{2}\/\d{2}\/\d{4})"\s*,\s*"bid_price"\s*:\s*"([0-9.]+)"/g;
  let m;
  while ((m = re.exec(decoded)) !== null) {
    const price = parseFloat(m[2]);
    if (price > 0.001 && price < 500) entries.push({ date: m[1], price });
  }
  // Sort descending — newest first
  entries.sort((a, b) => {
    const iso = d => d.split("/").reverse().join("-");
    return iso(b.date).localeCompare(iso(a.date));
  });
  return entries;
}

function calcPerformance(history) {
  if (!history.length) return {};
  const latest = history[0];
  const latestDate = parseDMY(latest.date);

  const findPriceAtOrBefore = (daysAgo) => {
    const target = new Date(latestDate);
    target.setDate(target.getDate() - daysAgo);
    for (const e of history) {
      if (parseDMY(e.date) <= target) return e.price;
    }
    return null;
  };

  const pct = (daysAgo) => {
    const old = findPriceAtOrBefore(daysAgo);
    if (old === null || old <= 0) return null;
    return +((( latest.price - old) / old) * 100).toFixed(2);
  };

  return {
    "1M":  pct(30),
    "3M":  pct(91),
    "6M":  pct(182),
    "1Y":  pct(365),
    "3Y":  pct(1095),
    "5Y":  pct(1825),
  };
}

// Downsample to weekly points for chart — keeps payload small while covering full history
function sampleForChart(history) {
  if (!history.length) return [];
  const result = [];
  let lastMs = null;
  // history is newest-first; iterate in reverse for oldest-first output
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    const ms = parseDMY(e.date).getTime();
    if (lastMs === null || (lastMs - ms) <= 0 || (ms - lastMs) >= 6 * 86400000) {
      result.push(e);
      lastMs = ms;
    }
  }
  return result; // oldest → newest (correct order for Chart.js)
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const name = (req.query.name || "").trim();
  if (!name) return res.status(400).json({ error: "Missing ?name= parameter" });

  const slug = FUND_SLUGS[name];
  if (!slug) return res.status(404).json({ error: "Unknown fund: " + name });

  // Cache 1 hour — performance data is updated once per business day
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=7200");

  try {
    const r = await fetch(`https://www.income.com.sg/funds/${slug}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return res.status(503).json({ error: `Fund page returned HTTP ${r.status}` });

    const html = await r.text();
    const history = extractAllPrices(html);

    if (!history.length) {
      return res.status(503).json({ error: "No price data found in fund page HTML" });
    }

    const performance = calcPerformance(history);
    const chartData = sampleForChart(history);

    return res.status(200).json({
      name,
      latest: history[0],
      performance,
      chartData,
      totalEntries: history.length,
      oldestDate: history[history.length - 1]?.date,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(503).json({ error: e.message });
  }
};
