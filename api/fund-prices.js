// Vercel serverless function — fetches Income fund prices server-side (no CORS restrictions).
// Tries individual fund pages first (may have ISR daily data), falls back to the
// historical-prices page (end-of-month HTML tables, always available).

const FUND_SLUGS = {
  "Income Global Absolute Alpha Fund":          "income-global-absolute-alpha-fund",
  "Income Global Artificial Intelligence":      "income-global-artificial-intelligence",
  "Income Global Dynamic Bond Fund":            "income-global-dynamic-bond-fund",
  "Income Global Emerging Markets Equity Fund": "income-global-emerging-markets-equity-fund",
  "Income Global Gold Equity Fund":             "income-global-gold-equity-fund",
  "Income Global Growth Equity Fund":           "income-global-growth-equity-fund",
  "Income Global Sustainable Fund":             "income-global-sustainable-fund",
  "Income Global Technology Fund":             "income-global-technology-fund",
  "Income India Equity Fund":                   "income-india-equity-fund",
  "Income Regional China Fund":                 "income-regional-china-fund",
  "Income US Large Cap Equity Fund":            "income-us-large-cap-equity-fund",
  "Income World Healthscience Fund":            "income-world-healthscience-fund",
  "Money Market Fund":                          "money-market-fund",
  "Takaful Fund":                               "takaful-fund",
};

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-SG,en-GB;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
};

function normFund(s) {
  return s.trim().toLowerCase()
    .replace(/^income\s+/i, "")
    .replace(/\s+fund$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

// Try to extract a bid/NAV price from a fund page's HTML.
// Checks __NEXT_DATA__ JSON first, then visible text patterns.
function extractPrice(html) {
  const ndMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (ndMatch) {
    const js = ndMatch[1];
    const re = /"(?:bidNav|bid_nav|bidNavPrice|navPrice|nav_price|bidPrice|bid_price|latestBidNav|currentNav|latestNav|unitPrice|currentPrice)"\s*:\s*"?([0-9]+\.[0-9]{2,8})"?/gi;
    let m;
    while ((m = re.exec(js)) !== null) {
      const p = parseFloat(m[1]);
      if (p > 0.05 && p < 500) return p;
    }
    try {
      function walk(o, d) {
        if (d > 30 || !o || typeof o !== "object") return null;
        const KEYS = ["bidNav","bid_nav","navPrice","nav_price","bidPrice","bid_price","latestBidNav","currentNav","latestNav","unitPrice"];
        for (const k of KEYS) {
          if (!(k in o)) continue;
          const v = o[k];
          if (typeof v === "number" && v > 0.05 && v < 500) return v;
          if (typeof v === "string") { const p = parseFloat(v); if (!isNaN(p) && p > 0.05 && p < 500) return p; }
        }
        for (const v of Object.values(o)) { const r = walk(v, d + 1); if (r) return r; }
        return null;
      }
      const p = walk(JSON.parse(js), 0);
      if (p) return p;
    } catch (e) {}
  }
  // Visible text: "Bid/NAV: 1.361000" or "Bid/NAV Price 1.361000"
  const clean = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ");
  const tm = clean.match(/bid[\s/\-]?nav\s*(?:price)?\s*[:\s$]+([0-9]+\.[0-9]{4,})/i);
  if (tm) { const p = parseFloat(tm[1]); if (p > 0.05 && p < 500) return p; }
  return null;
}

// Parse the HTML tables on income.com.sg/funds/historical-prices.
// Returns { normalisedFundName: price } using the first numeric cell per row.
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

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  // Cache 4 hours on Vercel's CDN — prices only update once per business day
  res.setHeader("Cache-Control", "s-maxage=14400, stale-while-revalidate=86400");

  const prices = {};

  // ── Step 1: Try every individual fund page in parallel ──
  // Server-side requests carry full browser headers and bypass CORS entirely.
  // If Income's Next.js site uses ISR with daily revalidation, these pages
  // will have today's price embedded in __NEXT_DATA__.
  await Promise.allSettled(
    Object.entries(FUND_SLUGS).map(async ([name, slug]) => {
      try {
        const r = await fetch(`https://www.income.com.sg/funds/${slug}`, {
          headers: HEADERS,
          signal: AbortSignal.timeout(12000),
        });
        if (!r.ok) return;
        const price = extractPrice(await r.text());
        if (price) prices[name] = price;
      } catch (e) {}
    })
  );

  // ── Step 2: Fill any missing funds from the historical-prices page ──
  const stillMissing = Object.keys(FUND_SLUGS).filter(n => !prices[n]);
  let source = Object.keys(prices).length > 0 ? "live" : null;

  if (stillMissing.length > 0) {
    try {
      const r = await fetch("https://www.income.com.sg/funds/historical-prices", {
        headers: HEADERS,
        signal: AbortSignal.timeout(18000),
      });
      if (r.ok) {
        const hist = parseHistoricalTable(await r.text());
        for (const name of stillMissing) {
          const p = hist[normFund(name)];
          if (p !== undefined) { prices[name] = p; source = source || "monthly"; }
        }
        // If live step got nothing, all prices came from historical page
        if (Object.keys(prices).length > 0 && !source) source = "monthly";
        if (source === null && Object.keys(prices).length > 0) source = "monthly";
      }
    } catch (e) {}
  }

  if (Object.keys(prices).length === 0) {
    return res.status(503).json({ error: "Could not fetch any prices from Income's website. Try again later." });
  }

  res.status(200).json({
    prices,
    source,                                                   // "live" | "monthly" | null
    fetchedAt: new Date().toISOString(),
    count: Object.keys(prices).length,
    missing: Object.keys(FUND_SLUGS).filter(n => !prices[n]),
  });
};
