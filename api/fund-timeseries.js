// Fetches full daily price history for a fund from Morningstar's timeseries_price endpoint.
// Returns up to 6+ years of daily NAV data — no manual price fetching needed.

const TOKEN = "klr5zyak8x";

const FUND_SECIDS = {
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
  // "Income Singapore Dividend Equity Fund" — Amova fund not in any Morningstar universe; no timeseries available
};

const HEADERS = {
  "Accept": "application/json, */*",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Referer": "https://fundsingapore.com/",
};

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  // Cache 24 hours — price data updates daily
  res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=172800");

  const name = (req.query.name || "").trim();
  const mapping = FUND_SECIDS[name];

  if (!mapping) {
    return res.status(200).json({ noMapping: true, name });
  }

  const { secId, universe } = mapping;
  // startDate: go back 6 years to give all period buttons (1M/3M/6M/1Y/3Y/5Y) enough data
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 6);
  const start = startDate.toISOString().split("T")[0];

  try {
    const url = `https://tools.morningstar.co.uk/api/rest.svc/timeseries_price/${TOKEN}`
      + `?id=${secId}]2]0]${encodeURIComponent(universe)}`
      + `&currencyId=SGD&idtype=Morningstar&frequency=daily`
      + `&startDate=${start}&outputType=json`;

    const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Morningstar HTTP ${r.status}`);
    const data = await r.json();

    const history = data?.TimeSeries?.Security?.[0]?.HistoryDetail || [];
    if (!history.length) throw new Error("No price history returned");

    // Return as [{date:"YYYY-MM-DD", price:number}] oldest-first
    const prices = history.map(h => ({
      date: h.EndDate,
      price: parseFloat(h.Value),
    })).filter(h => h.date && !isNaN(h.price));

    return res.status(200).json({
      name, secId,
      count: prices.length,
      from: prices[0]?.date,
      to: prices[prices.length - 1]?.date,
      prices,
      source: "Morningstar timeseries",
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(503).json({ error: e.message, name, secId });
  }
};
