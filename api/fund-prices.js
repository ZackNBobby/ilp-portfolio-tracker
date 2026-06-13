// Vercel serverless function — fetches live Income ILP fund prices.
// Primary: Income's internal /api/fund-prices/custom-range (discovered from JS bundle).
// Fallback: Income historical-prices HTML page (end-of-month, always available).

const FUND_SLUGS = [
  "income-global-absolute-alpha-fund",
  "income-global-artificial-intelligence",
  "income-global-dynamic-bond-fund",
  "income-global-emerging-markets-equity-fund",
  "income-global-gold-equity-fund",
  "income-global-growth-equity-fund",
  "income-global-sustainable-fund",
  "income-global-technology-fund",
  "income-india-equity-fund",
  "income-regional-china-fund",
  "income-us-large-cap-equity-fund",
  "income-world-healthscience-fund",
  "money-market-fund",
  "takaful-fund",
];

// Map slug → display name (matches what's stored in Firestore)
const SLUG_TO_NAME = {
  "income-global-absolute-alpha-fund":          "Income Global Absolute Alpha Fund",
  "income-global-artificial-intelligence":      "Income Global Artificial Intelligence",
  "income-global-dynamic-bond-fund":            "Income Global Dynamic Bond Fund",
  "income-global-emerging-markets-equity-fund": "Income Global Emerging Markets Equity Fund",
  "income-global-gold-equity-fund":             "Income Global Gold Equity Fund",
  "income-global-growth-equity-fund":           "Income Global Growth Equity Fund",
  "income-global-sustainable-fund":             "Income Global Sustainable Fund",
  "income-global-technology-fund":              "Income Global Technology Fund",
  "income-india-equity-fund":                   "Income India Equity Fund",
  "income-regional-china-fund":                 "Income Regional China Fund",
  "income-us-large-cap-equity-fund":            "Income US Large Cap Equity Fund",
  "income-world-healthscience-fund":            "Income World Healthscience Fund",
  "money-market-fund":                          "Money Market Fund",
  "takaful-fund":                               "Takaful Fund",
};

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "application/json, text/html, */*",
  "Accept-Language": "en-SG,en-GB;q=0.9,en;q=0.8",
  "Referer": "https://www.income.com.sg/",
  "Cache-Control": "no-cache",
};

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Walk any JSON structure to find the first price-like number
function findPrice(obj, depth = 0) {
  if (depth > 10 || !obj || typeof obj !== "object") return null;
  const PRICE_KEYS = ["latest_bid_price","bid_price","bidPrice","price","nav","navPrice","unitPrice","latestBidPrice"];
  for (const k of PRICE_KEYS) {
    if (k in obj) {
      const v = typeof obj[k] === "number" ? obj[k] : parseFloat(obj[k]);
      if (!isNaN(v) && v > 0.05 && v < 500) return v;
    }
  }
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) {
      for (const item of v) { const r = findPrice(item, depth + 1); if (r) return r; }
    } else if (v && typeof v === "object") {
      const r = findPrice(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

// ── Strategy 1: Income live API ──────────────────────────────────────────────
async function fetchLivePrice(slug) {
  const today = isoDate(new Date());
  // Use 30-day window to ensure we catch the most recent business day price
  const monthAgo = isoDate(new Date(Date.now() - 30 * 86400000));

  // Try multiple date formats in case the API is picky
  const dateFormats = [
    { start_date: monthAgo, end_date: today },
    // DD/MM/YYYY format
    {
      start_date: monthAgo.split("-").reverse().join("/"),
      end_date: today.split("-").reverse().join("/"),
    },
  ];

  for (const dates of dateFormats) {
    const params = new URLSearchParams({ fund_code: slug, ...dates });
    const url = `https://www.income.com.sg/api/fund-prices/custom-range?${params}`;
    try {
      const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
      if (!r.ok) continue;
      const data = await r.json();
      // Response may be object or array
      const price = Array.isArray(data)
        ? (() => {
            // Sort by date desc, take the latest entry
            const sorted = [...data].sort((a, b) => String(b.date || b.as_of_date || "").localeCompare(String(a.date || a.as_of_date || "")));
            return findPrice(sorted[0] || {});
          })()
        : findPrice(data);
      if (price) return { price, source: "live", asOf: data.as_of_date || today };
    } catch { /* try next format */ }
  }
  return null;
}

// ── Strategy 2: Income historical-prices HTML (fallback) ─────────────────────
function normFund(s) {
  return s.trim().toLowerCase()
    .replace(/^income\s+/i, "")
    .replace(/\s+fund$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

async function fetchHistoricalAll() {
  try {
    const r = await fetch("https://www.income.com.sg/funds/historical-prices", {
      headers: { ...HEADERS, Accept: "text/html" },
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
  // Prices update once per business day — cache 4 h on CDN
  res.setHeader("Cache-Control", "s-maxage=14400, stale-while-revalidate=86400");

  const prices = {};
  const sourceMap = {};

  // Step 1: Fetch all funds from live API in parallel
  await Promise.allSettled(
    FUND_SLUGS.map(async slug => {
      const result = await fetchLivePrice(slug);
      if (result) {
        const name = SLUG_TO_NAME[slug];
        prices[name] = result.price;
        sourceMap[name] = result.source;
      }
    })
  );

  // Step 2: Fill missing with historical page
  const missing = FUND_SLUGS.filter(s => !prices[SLUG_TO_NAME[s]]);
  if (missing.length > 0) {
    const hist = await fetchHistoricalAll();
    for (const slug of missing) {
      const name = SLUG_TO_NAME[slug];
      const p = hist[normFund(name)];
      if (p !== undefined) { prices[name] = p; sourceMap[name] = "historical"; }
    }
  }

  if (Object.keys(prices).length === 0) {
    return res.status(503).json({ error: "Could not fetch any fund prices. Try again later." });
  }

  const liveSources = ["live"];
  const hasLive = Object.values(sourceMap).some(s => liveSources.includes(s));
  const hasHistorical = Object.values(sourceMap).some(s => s === "historical");

  res.status(200).json({
    prices,
    source: hasLive && !hasHistorical ? "live" : hasLive ? "mixed" : "historical",
    sourceDetail: sourceMap,
    fetchedAt: new Date().toISOString(),
    count: Object.keys(prices).length,
    missing: FUND_SLUGS.filter(s => !prices[SLUG_TO_NAME[s]]).map(s => SLUG_TO_NAME[s]),
  });
};
