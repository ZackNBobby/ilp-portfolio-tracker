// Vercel serverless function — fetches Income ILP fund prices server-side.
// Strategy order:
//   1. Income /_next/data/ ISR JSON  (live, if Income bakes price into SSR)
//   2. Financial Times fund search    (live, static HTML)
//   3. Income historical-prices page  (end-of-month, always works)

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

// FT search terms mapped to fund names — FT uses short names
const FT_SEARCH_TERMS = {
  "Income Global Absolute Alpha Fund":          "NTUC Income Global Absolute Alpha",
  "Income Global Artificial Intelligence":      "NTUC Income Global Artificial Intelligence",
  "Income Global Dynamic Bond Fund":            "NTUC Income Global Dynamic Bond",
  "Income Global Emerging Markets Equity Fund": "NTUC Income Global Emerging Markets Equity",
  "Income Global Gold Equity Fund":             "NTUC Income Global Gold Equity",
  "Income Global Growth Equity Fund":           "NTUC Income Global Growth Equity",
  "Income Global Sustainable Fund":             "NTUC Income Global Sustainable",
  "Income Global Technology Fund":              "NTUC Income Global Technology",
  "Income India Equity Fund":                   "NTUC Income India Equity",
  "Income Regional China Fund":                 "NTUC Income Regional China",
  "Income US Large Cap Equity Fund":            "NTUC Income US Large Cap Equity",
  "Income World Healthscience Fund":            "NTUC Income World Healthscience",
  "Money Market Fund":                          "NTUC Income Money Market",
  "Takaful Fund":                               "NTUC Income Takaful",
};

const HEADERS_HTML = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-SG,en-GB;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
};
const HEADERS_JSON = {
  ...HEADERS_HTML,
  "Accept": "application/json, text/plain, */*",
};

function normFund(s) {
  return s.trim().toLowerCase()
    .replace(/^(?:ntuc\s+)?income\s+/i, "")
    .replace(/\s+fund$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

// ── Strategy 1: Income /_next/data/ ISR JSON ────────────────────────────────
// Next.js exposes server-rendered page props as JSON at this path.
// If Income bakes the current bid/NAV price into getStaticProps/getServerSideProps,
// this will return today's price without needing to execute any JavaScript.

async function getBuildId() {
  try {
    const r = await fetch("https://www.income.com.sg/", {
      headers: HEADERS_HTML,
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/"buildId"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

function walkForPrice(obj, depth = 0) {
  if (depth > 20 || !obj || typeof obj !== "object") return null;
  const PRICE_KEYS = new Set([
    "bidNav","bid_nav","bidNavPrice","navPrice","nav_price","bidPrice","bid_price",
    "latestBidNav","currentNav","latestNav","unitPrice","currentPrice","fundPrice",
    "price","nav","bid","offer","offerPrice","latestPrice","currentBidPrice",
    "latestBidPrice","bidNavValue","navValue",
  ]);
  for (const [k, v] of Object.entries(obj)) {
    if (PRICE_KEYS.has(k.toLowerCase()) || PRICE_KEYS.has(k)) {
      const p = typeof v === "number" ? v : parseFloat(v);
      if (!isNaN(p) && p > 0.05 && p < 500) return p;
    }
  }
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) {
      for (const item of v) {
        const r = walkForPrice(item, depth + 1);
        if (r !== null) return r;
      }
    } else if (v && typeof v === "object") {
      const r = walkForPrice(v, depth + 1);
      if (r !== null) return r;
    }
  }
  return null;
}

async function fetchFromIncomeNextData(buildId, slug) {
  try {
    const url = `https://www.income.com.sg/_next/data/${buildId}/funds/${slug}.json`;
    const r = await fetch(url, { headers: HEADERS_JSON, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const data = await r.json();
    return walkForPrice(data);
  } catch { return null; }
}

// Also try the raw fund page __NEXT_DATA__ with improved extraction
async function fetchFromIncomePage(slug) {
  try {
    const r = await fetch(`https://www.income.com.sg/funds/${slug}`, {
      headers: HEADERS_HTML,
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return null;
    const html = await r.text();

    // Try __NEXT_DATA__ first
    const ndMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (ndMatch) {
      try {
        const p = walkForPrice(JSON.parse(ndMatch[1]));
        if (p) return p;
      } catch {}
      // Regex fallback on raw JSON string — catches any numeric field with price-like key
      const re = /"(?:[a-zA-Z]*[Bb]id[a-zA-Z]*|[a-zA-Z]*[Nn]av[a-zA-Z]*|[a-zA-Z]*[Pp]rice[a-zA-Z]*|unitPrice|fundPrice)"\s*:\s*"?([0-9]+\.[0-9]{3,8})"?/g;
      let m;
      while ((m = re.exec(ndMatch[1])) !== null) {
        const p = parseFloat(m[1]);
        if (p > 0.05 && p < 500) return p;
      }
    }

    // Visible text patterns in stripped HTML
    const clean = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ");
    const patterns = [
      /bid[\s/\-]?nav\s*(?:price)?\s*[:\s]+([0-9]+\.[0-9]{4,})/i,
      /current\s+(?:bid\s+)?(?:nav\s+)?price\s*[:\s]+([0-9]+\.[0-9]{4,})/i,
      /unit\s+price\s*[:\s]+([0-9]+\.[0-9]{4,})/i,
    ];
    for (const pat of patterns) {
      const tm = clean.match(pat);
      if (tm) { const p = parseFloat(tm[1]); if (p > 0.05 && p < 500) return p; }
    }
    return null;
  } catch { return null; }
}

// ── Strategy 2: Financial Times fund search ──────────────────────────────────
// FT's fund pages render prices server-side in static HTML.
// We search for each fund and parse the NAV/price from the results.

async function fetchFromFT(fundName) {
  try {
    const query = encodeURIComponent(FT_SEARCH_TERMS[fundName] || fundName);
    // FT autocomplete / search JSON
    const searchUrl = `https://markets.ft.com/data/search?query=${query}&assetClass=funds`;
    const r = await fetch(searchUrl, { headers: HEADERS_HTML, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const html = await r.text();

    // FT search results pages embed prices in data-* attributes or structured spans
    // Look for NAV price patterns in the rendered HTML
    const pricePatterns = [
      /class="[^"]*price[^"]*"[^>]*>\s*([0-9]+\.[0-9]{2,6})/gi,
      /"price"\s*:\s*([0-9]+\.[0-9]{2,6})/gi,
      /"nav"\s*:\s*([0-9]+\.[0-9]{2,6})/gi,
      /data-price="([0-9]+\.[0-9]{2,6})"/gi,
    ];
    for (const pat of pricePatterns) {
      let m;
      while ((m = pat.exec(html)) !== null) {
        const p = parseFloat(m[1]);
        if (p > 0.05 && p < 500) return p;
      }
    }
    return null;
  } catch { return null; }
}

// ── Strategy 3: Income historical-prices page ────────────────────────────────
function parseHistoricalTable(html) {
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
}

async function fetchHistorical(missing) {
  try {
    const r = await fetch("https://www.income.com.sg/funds/historical-prices", {
      headers: HEADERS_HTML,
      signal: AbortSignal.timeout(18000),
    });
    if (!r.ok) return {};
    const hist = parseHistoricalTable(await r.text());
    const found = {};
    for (const name of missing) {
      const p = hist[normFund(name)];
      if (p !== undefined) found[name] = p;
    }
    return found;
  } catch { return {}; }
}

// ── Handler ──────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  // Prices update once per business day — cache 4 h, serve stale up to 24 h
  res.setHeader("Cache-Control", "s-maxage=14400, stale-while-revalidate=86400");

  const prices = {};
  const sourceMap = {}; // per-fund source tracking

  // ── Step 1: Income /_next/data/ ISR JSON ──
  const buildId = await getBuildId();
  if (buildId) {
    await Promise.allSettled(
      Object.entries(FUND_SLUGS).map(async ([name, slug]) => {
        const p = await fetchFromIncomeNextData(buildId, slug);
        if (p) { prices[name] = p; sourceMap[name] = "income-isr"; }
      })
    );
  }

  // ── Step 1b: Income raw fund page (improved extraction) for still-missing ──
  const afterIsr = Object.keys(FUND_SLUGS).filter(n => !prices[n]);
  if (afterIsr.length > 0) {
    await Promise.allSettled(
      afterIsr.map(async name => {
        const p = await fetchFromIncomePage(FUND_SLUGS[name]);
        if (p) { prices[name] = p; sourceMap[name] = "income-page"; }
      })
    );
  }

  // ── Step 2: Financial Times for still-missing ──
  const afterIncome = Object.keys(FUND_SLUGS).filter(n => !prices[n]);
  if (afterIncome.length > 0) {
    await Promise.allSettled(
      afterIncome.map(async name => {
        const p = await fetchFromFT(name);
        if (p) { prices[name] = p; sourceMap[name] = "ft"; }
      })
    );
  }

  // ── Step 3: Historical prices for anything still missing ──
  const stillMissing = Object.keys(FUND_SLUGS).filter(n => !prices[n]);
  if (stillMissing.length > 0) {
    const hist = await fetchHistorical(stillMissing);
    for (const [name, p] of Object.entries(hist)) {
      prices[name] = p;
      sourceMap[name] = "historical";
    }
  }

  if (Object.keys(prices).length === 0) {
    return res.status(503).json({ error: "Could not fetch any fund prices. Try again later." });
  }

  // Determine overall source label for the UI
  const sources = new Set(Object.values(sourceMap));
  const overallSource = sources.has("income-isr") || sources.has("income-page") || sources.has("ft")
    ? (sources.has("historical") ? "mixed" : "live")
    : "historical";

  res.status(200).json({
    prices,
    source: overallSource,
    sourceDetail: sourceMap,
    buildId: buildId || null,
    fetchedAt: new Date().toISOString(),
    count: Object.keys(prices).length,
    missing: Object.keys(FUND_SLUGS).filter(n => !prices[n]),
  });
};
