// Vercel serverless function — fetches Morningstar performance data for Income ILP sub-funds.
// Uses Morningstar's public CDN screener API (no auth required, same data as FundSingapore.com).
// Returns: 1M, 3M, 6M, 1Y, 3Y, 5Y returns + star rating + AUM.

const TOKEN = "klr5zyak8x";
const UNIVERSE = "FOSGP%24%24ALL"; // Singapore offshore fund universe

// Morningstar SecId → Income ILP fund name mapping.
// SecIds discovered via fundsingapore.com fund detail pages.
// Add more as sub-fund details become available from Income's factsheets.
const FUND_MAP = {
  "Income Global Absolute Alpha Fund": {
    secId: "F000016EDC",
    searchTerm: "Fullerton Lux Absolute Alpha SGD",
    note: "Fullerton Lux Funds – Global Absolute Alpha A SGD Cap",
  },
  "Income Global Dynamic Bond Fund": {
    secId: "F00000IRSW",
    searchTerm: "PIMCO GIS Dynamic Bond E Inc",
    note: "PIMCO GIS Dynamic Bond Fund",
  },
  "Income Global Gold Equity Fund": {
    secId: "F0GBR04AR8",
    searchTerm: "BGF World Gold A2 USD",
    note: "BGF World Gold Fund A2 USD",
  },
  "Income World Healthscience Fund": {
    secId: "F0GBR04K8L",
    searchTerm: "BGF World Healthscience A2 USD",
    note: "BGF World Healthscience Fund A2 USD",
  },
  "Income India Equity Fund": {
    secId: "F00000JTUS",
    searchTerm: "Franklin India acc SGD",
    note: "Franklin India Fund A(acc) SGD",
  },
};

const DATA_POINTS = [
  "SecId", "Name", "StarRatingM255", "ReturnM0",
  "GBRReturnM1", "GBRReturnM3", "GBRReturnM6",
  "ReturnM12", "ReturnM36", "ReturnM60",
  "TotalAssets", "CategoryName",
].join(",");

const HEADERS = {
  "Accept": "application/json, text/plain, */*",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Referer": "https://fundsingapore.com/",
};

async function queryMorningstar(params) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&");
  const url = `https://lt.morningstar.com/api/rest.svc/${TOKEN}/security/screener?${qs}`;
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`Morningstar HTTP ${r.status}`);
  const data = await r.json();
  return data.rows || [];
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  // Cache 24 hours — Morningstar performance data updates monthly
  res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=172800");

  const name = (req.query.name || "").trim();
  const mapping = FUND_MAP[name];

  if (!mapping) {
    return res.status(200).json({
      noMapping: true,
      name,
      message: "Sub-fund not yet mapped to Morningstar. Add SecId in api/fund-morningstar.js.",
    });
  }

  const { secId, searchTerm, note } = mapping;
  const baseParams = {
    outputType: "json",
    languageId: "en-SG",
    securityDataPoints: encodeURIComponent(DATA_POINTS),
    universeIds: UNIVERSE,
  };

  try {
    // Strategy 1: filter by exact SecId
    let rows = await queryMorningstar({
      ...baseParams,
      filters: encodeURIComponent(`SecId in (${secId})`),
    });

    // Strategy 2: search by term and pick the matching SecId
    if (!rows.length) {
      rows = await queryMorningstar({
        ...baseParams,
        term: encodeURIComponent(searchTerm),
      });
      // Try to find the known SecId in results; otherwise take first
      const exact = rows.find(r => r.SecId === secId);
      if (exact) rows = [exact];
      else if (rows.length > 0) rows = [rows[0]];
    }

    if (!rows.length) {
      return res.status(200).json({
        error: "Fund not found in Morningstar screener",
        name, secId,
      });
    }

    const row = rows[0];
    const pct = v => (v === null || v === undefined) ? null : +v.toFixed(2);

    return res.status(200).json({
      name,
      secId,
      morningstarName: row.Name,
      subFundNote: note,
      starRating: row.StarRatingM255 || null,
      totalAssets: row.TotalAssets ? (row.TotalAssets / 1e6).toFixed(0) : null, // in millions
      categoryName: row.CategoryName || null,
      performance: {
        "YTD": pct(row.ReturnM0),
        "1M":  pct(row.GBRReturnM1),
        "3M":  pct(row.GBRReturnM3),
        "6M":  pct(row.GBRReturnM6),
        "1Y":  pct(row.ReturnM12),
        "3Y":  pct(row.ReturnM36),
        "5Y":  pct(row.ReturnM60),
      },
      source: "Morningstar",
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(503).json({ error: e.message, name, secId });
  }
};
