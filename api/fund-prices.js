// Vercel serverless function — fetches live Income ILP fund prices.
// Prices are embedded in each fund page's HTML as HTML-encoded JSON.
// Falls back to the historical-prices page if individual pages fail.

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

// Extract the most recent bid price from a fund page HTML.
// Pages embed price history as HTML-encoded JSON:
//   {&quot;day&quot;:&quot;11/06/2026&quot;,&quot;bid_price&quot;:&quot;0.974000&quot;,...}
function extractLatestBidPrice(html) {
  // HTML-decode &quot; → "  so we can parse the JSON entries
  const decoded = html.replace(/&quot;/g, '"');

  // Find all daily price entries: {"day":"DD/MM/YYYY","bid_price":"X.XXXXXX",...}
  const entries = [];
  const re = /"day"\s*:\s*"(\d{2}\/\d{2}\/\d{4})"\s*,\s*"bid_price"\s*:\s*"([0-9.]+)"/g;
  let m;
  while ((m = re.exec(decoded)) !== null) {
    entries.push({ day: m[1], price: parseFloat(m[2]) });
  }

  if (entries.length === 0) return null;

  // Sort by date descending (DD/MM/YYYY → compare as YYYY-MM-DD)
  entries.sort((a, b) => {
    const toIso = d => d.split("/").reverse().join("-");
    return toIso(b.day).localeCompare(toIso(a.day));
  });

  const latest = entries[0];
  if (latest.price > 0.01 && latest.price < 500) return { price: latest.price, date: latest.day };
  return null;
}

// ── Strategy 1: individual fund pages (live data in HTML) ────────────────────
async function fetchFundPagePrice(slug) {
  try {
    const r = await fetch(`https://www.income.com.sg/funds/${slug}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    return extractLatestBidPrice(await r.text());
  } catch { return null; }
}

// ── Strategy 2: historical-prices page fallback ──────────────────────────────
function normFund(s) {
  return s.trim().toLowerCase()
    .replace(/^income\s+/i, "")
    .replace(/\s+fund$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

async function fetchHistoricalAll() {
  try {
    const r = await fetch("https://www.income.com.sg/funds/historical-prices", {
      headers: HEADERS,
      signal: AbortSignal.timeout(18000),
    });
    if (!r.ok) return {};
    const html = await r.text();
    const map = {};
    const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const row of rows) {
      const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
        .map(c => c.replace(/<[^>]+>/g, "").trim());
      if (cells.length < 2 || !cells[0] || cells[0].length < 4) continue;
      for (let i = 1; i < cells.length; i++) {
        const price = parseFloat(cells[i].replace(/[,$\s]/g, ""));
        if (!isNaN(price) && price > 0.001 && price < 500) {
          map[normFund(cells[0])] = price;
          break;
        }
      }
    }
    return map;
  } catch { return {}; }
}

// ── Handler ──────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  // Cache 4 hours — prices update once per business day
  res.setHeader("Cache-Control", "s-maxage=14400, stale-while-revalidate=86400");

  const prices = {};
  const sourceMap = {};
  const asOfMap = {};

  // Step 1: fetch all fund pages in parallel for live prices
  await Promise.allSettled(
    Object.entries(FUND_SLUGS).map(async ([name, slug]) => {
      const result = await fetchFundPagePrice(slug);
      if (result) {
        prices[name] = result.price;
        sourceMap[name] = "live";
        asOfMap[name] = result.date;
      }
    })
  );

  // Step 2: fill any missing funds from the historical-prices page
  const missing = Object.keys(FUND_SLUGS).filter(n => !prices[n]);
  if (missing.length > 0) {
    const hist = await fetchHistoricalAll();
    for (const name of missing) {
      const p = hist[normFund(name)];
      if (p !== undefined) { prices[name] = p; sourceMap[name] = "historical"; }
    }
  }

  if (Object.keys(prices).length === 0) {
    return res.status(503).json({ error: "Could not fetch any fund prices. Try again later." });
  }

  const hasLive = Object.values(sourceMap).some(s => s === "live");
  const hasHist = Object.values(sourceMap).some(s => s === "historical");

  res.status(200).json({
    prices,
    source: hasLive && !hasHist ? "live" : hasLive ? "mixed" : "historical",
    sourceDetail: sourceMap,
    asOf: asOfMap,
    fetchedAt: new Date().toISOString(),
    count: Object.keys(prices).length,
    missing: Object.keys(FUND_SLUGS).filter(n => !prices[n]),
  });
};
