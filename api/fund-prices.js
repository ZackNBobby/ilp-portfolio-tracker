// Vercel serverless function — fetches live Income ILP fund prices.
// Current price + 1D/7D: scraped from Income fund pages (most accurate for bid price).
// 30D / 1Y / Since Inception: from Morningstar timeseries (6 years of daily data).

const FUND_SLUGS = {
  "Income Asia Dynamic Return Fund":            "asia-dynamic-return-fund",
  "Income Global Absolute Alpha Fund":          "income-global-absolute-alpha-fund",
  "Income Global Artificial Intelligence":      "income-global-artificial-intelligence",
  "Income Global Dynamic Bond Fund":            "income-global-dynamic-bond-fund",
  "Income Global Emerging Markets Equity Fund": "income-global-emerging-markets-equity-fund",
  "Income Global Gold Equity Fund":             "income-global-gold-equity-fund",
  "Income Global Growth Equity Fund":           "income-global-growth-equity-fund",
  "Income Global Sustainable Fund":             "income-global-sustainable-fund",
  "Income Global Technology Fund":              "global-technology-fund",
  "Income India Equity Fund":                   "income-india-equity-fund",
  "Income Japan Dividend Equity Fund":          "income-japan-dividend-equity-fund",
  "Income Regional China Fund":                 "income-regional-china-fund",
  "Income Singapore Dividend Equity Fund":      "income-singapore-dividend-equity-fund",
  "Income US Dividend and Growth Fund":         "income-us-dividend-and-growth-fund",
  "Income US Large Cap Equity Fund":            "income-us-large-cap-equity-fund",
  "Income World Healthscience Fund":            "income-world-healthscience-fund",
  "Money Market Fund":                          "money-market-fund",
  "Takaful Fund":                               "takaful-fund",
};

// Morningstar secIds for funds that have history there.
// Money Market, Takaful, Singapore Dividend, Asia Dynamic Return, Global Technology
// do not have Morningstar mappings — 30D/1Y/Since Inception will be null for those.
const FUND_MORNINGSTAR = {
  "Income Global Absolute Alpha Fund":          { secId: "F000016EDC", universe: "FOSGP$$ALL" },
  "Income Global Dynamic Bond Fund":            { secId: "F00000PHFD", universe: "FOSGP$$ALL" },
  "Income Global Gold Equity Fund":             { secId: "F0GBR04AR8", universe: "FOSGP$$ALL" },
  "Income World Healthscience Fund":            { secId: "F0GBR04K8L", universe: "FOSGP$$ALL" },
  "Income India Equity Fund":                   { secId: "F00000JTUS", universe: "FOSGP$$ALL" },
  "Income Global Artificial Intelligence":      { secId: "F00000ZVQS", universe: "FOSGP$$ALL" },
  "Income Global Emerging Markets Equity Fund": { secId: "F00000PN6R", universe: "FOSGP$$ALL" },
  "Income Global Growth Equity Fund":           { secId: "F00001QUO9", universe: "FOSGP$$ALL" },
  "Income Regional China Fund":                 { secId: "F0HKG062N3", universe: "FOSGP$$ALL" },
  "Income US Large Cap Equity Fund":            { secId: "F00001QUO7", universe: "FOSGP$$ALL" },
  "Income Global Sustainable Fund":             { secId: "F000016LX1", universe: "FOEUR$$ALL" },
  "Income US Dividend and Growth Fund":         { secId: "F00000Q4B0", universe: "FOSGP$$ALL" },
  "Income Japan Dividend Equity Fund":          { secId: "F00000Q3EG", universe: "FOSGP$$ALL" },
};

const MS_TOKEN = "klr5zyak8x";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,*/*",
  "Accept-Language": "en-SG,en-GB;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
};

// ── Income fund page scraper — current price + 1D/7D only ───────────────────
function extractPriceData(html) {
  const entries = [];
  const seen = new Set();

  // Strategy 1: __NEXT_DATA__ JSON
  const ndMatch = html.match(/<script id="__NEXT_DATA__"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  if (ndMatch) {
    try {
      const nd = JSON.parse(ndMatch[1]);
      const walk = (obj) => {
        if (!obj || typeof obj !== "object") return;
        if (Array.isArray(obj)) {
          if (obj.length > 0 && obj[0]?.day && obj[0]?.bid_price) {
            for (const e of obj) {
              const price = parseFloat(e.bid_price);
              if (e.day && price > 0.001 && price < 500 && !seen.has(e.day)) {
                seen.add(e.day);
                entries.push({ day: e.day, price });
              }
            }
            return;
          }
          obj.forEach(walk);
        } else { Object.values(obj).forEach(walk); }
      };
      walk(nd);
    } catch {}
  }

  // Strategy 2: HTML-encoded JSON
  const decoded = html.replace(/&quot;/g, '"');
  const re = /"day"\s*:\s*"(\d{2}\/\d{2}\/\d{4})"\s*,\s*"bid_price"\s*:\s*"([0-9.]+)"/g;
  let m;
  while ((m = re.exec(decoded)) !== null) {
    const price = parseFloat(m[2]);
    if (price > 0.001 && price < 500 && !seen.has(m[1])) {
      seen.add(m[1]);
      entries.push({ day: m[1], price });
    }
  }

  entries.sort((a, b) => {
    const toIso = d => d.split("/").reverse().join("-");
    return toIso(b.day).localeCompare(toIso(a.day)); // newest first
  });

  if (!entries.length) return null;
  const latest = entries[0];
  if (latest.price <= 0.01 || latest.price >= 500) return null;

  const latestDate = new Date(latest.day.split("/").reverse().join("-"));
  const pctChange = (daysAgo) => {
    const target = new Date(latestDate);
    target.setDate(target.getDate() - daysAgo);
    for (const e of entries) {
      const d = new Date(e.day.split("/").reverse().join("-"));
      if (d <= target) return +((latest.price - e.price) / e.price * 100).toFixed(2);
    }
    return null;
  };

  return {
    price: latest.price,
    date: latest.day,
    change1D: pctChange(1),
    change7D: pctChange(7),
  };
}

async function fetchFundPagePrice(slug) {
  try {
    const r = await fetch(`https://www.income.com.sg/funds/${slug}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    return extractPriceData(await r.text());
  } catch { return null; }
}

// ── Morningstar timeseries — 30D / 1Y / Since Inception ─────────────────────
async function fetchMorningstarPerf(name) {
  const mapping = FUND_MORNINGSTAR[name];
  if (!mapping) return null;

  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 7); // 7 years to cover all since-inception cases
  const start = startDate.toISOString().split("T")[0];

  try {
    const url = `https://tools.morningstar.co.uk/api/rest.svc/timeseries_price/${MS_TOKEN}`
      + `?id=${mapping.secId}]2]0]${encodeURIComponent(mapping.universe)}`
      + `&currencyId=SGD&idtype=Morningstar&frequency=daily`
      + `&startDate=${start}&outputType=json`;

    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }, signal: AbortSignal.timeout(18000) });
    if (!r.ok) return null;
    const data = await r.json();

    const history = (data?.TimeSeries?.Security?.[0]?.HistoryDetail || [])
      .map(h => ({ date: h.EndDate, price: parseFloat(h.Value) }))
      .filter(h => h.date && !isNaN(h.price) && h.price > 0);

    if (!history.length) return null;

    // Morningstar returns oldest-first; reverse to newest-first
    history.reverse();
    const latest = history[0];
    const latestDate = new Date(latest.date);

    const pctChange = (daysAgo) => {
      const target = new Date(latestDate);
      target.setDate(target.getDate() - daysAgo);
      for (const e of history) {
        if (new Date(e.date) <= target) return +((latest.price - e.price) / e.price * 100).toFixed(2);
      }
      return null;
    };

    const oldest = history[history.length - 1];
    const sinceInception = oldest && oldest.date !== latest.date
      ? +((latest.price - oldest.price) / oldest.price * 100).toFixed(2)
      : null;

    return {
      change30D: pctChange(30),
      change1Y: pctChange(365),
      changeSinceInception: sinceInception,
      oldestDate: oldest?.date ?? null, // ISO format YYYY-MM-DD
    };
  } catch { return null; }
}

// ── Historical-prices page fallback for missing current prices ───────────────
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
  const change1DMap = {};
  const change7DMap = {};
  const change30DMap = {};
  const change1YMap = {};
  const changeSinceInceptionMap = {};
  const oldestDateMap = {};

  // Run Income page scrapes and Morningstar fetches in parallel
  const [incomeResults, msResults] = await Promise.all([
    Promise.allSettled(
      Object.entries(FUND_SLUGS).map(async ([name, slug]) => {
        const result = await fetchFundPagePrice(slug);
        return { name, result };
      })
    ),
    Promise.allSettled(
      Object.keys(FUND_SLUGS).map(async (name) => {
        const perf = await fetchMorningstarPerf(name);
        return { name, perf };
      })
    ),
  ]);

  // Apply Income page results (current price + 1D/7D)
  for (const r of incomeResults) {
    if (r.status !== "fulfilled") continue;
    const { name, result } = r.value;
    if (result && result.price) {
      prices[name] = result.price;
      sourceMap[name] = "live";
      asOfMap[name] = result.date;
      if (result.change1D != null) change1DMap[name] = result.change1D;
      if (result.change7D != null) change7DMap[name] = result.change7D;
    }
  }

  // Apply Morningstar results (30D / 1Y / Since Inception)
  for (const r of msResults) {
    if (r.status !== "fulfilled") continue;
    const { name, perf } = r.value;
    if (!perf) continue;
    if (perf.change30D  != null) change30DMap[name]             = perf.change30D;
    if (perf.change1Y   != null) change1YMap[name]              = perf.change1Y;
    if (perf.changeSinceInception != null) changeSinceInceptionMap[name] = perf.changeSinceInception;
    if (perf.oldestDate != null) oldestDateMap[name]            = perf.oldestDate;
  }

  // Fill any missing current prices from the historical-prices fallback page
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
    change1D: change1DMap,
    change7D: change7DMap,
    change30D: change30DMap,
    change1Y: change1YMap,
    changeSinceInception: changeSinceInceptionMap,
    oldestDate: oldestDateMap,
    source: hasLive && !hasHist ? "live" : hasLive ? "mixed" : "historical",
    sourceDetail: sourceMap,
    asOf: asOfMap,
    fetchedAt: new Date().toISOString(),
    count: Object.keys(prices).length,
    missing: Object.keys(FUND_SLUGS).filter(n => !prices[n]),
  });
};
