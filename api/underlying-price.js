// Fetches the latest price for an underlying institutional fund via FT.com chart API.
// Called with ?symbol=LU2264538146:SGD (ISIN:currency format from FT.com).

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://markets.ft.com/data/funds/tearsheet/charts",
};

// FT chartapi/series response:
//   { Data: [{ Elements: [{ Type:"price", ComponentSeries: [{Type:"Close", Values:[...]}] }], Dates:[[y,m,d],...] }] }
function extractLatestClose(data) {
  const blocks = data?.Data || [];
  for (const block of blocks) {
    const elements = block?.Elements || [];
    for (const el of elements) {
      const cs = el?.ComponentSeries || [];
      const close = cs.find(s => s.Type === "Close" || s.Type === "close");
      if (!close) continue;
      const vals = (close.Values || []).filter(v => v != null && !isNaN(v) && v > 0);
      if (vals.length > 0) return { price: vals[vals.length - 1], count: vals.length };
    }
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  // Cache 4 hours — underlying fund prices update during the trading day
  res.setHeader("Cache-Control", "s-maxage=14400, stale-while-revalidate=86400");

  const symbol = (req.query.symbol || "").trim();
  if (!symbol) return res.status(400).json({ error: "Missing ?symbol= parameter (e.g. LU2264538146:SGD)" });

  const enc = encodeURIComponent(symbol);
  const url = `https://markets.ft.com/data/chartapi/series?days=30&dataNormalized=false&dataPeriod=Day&dataInterval=1&realTimeData=false&closingTimesBands=false&numberofResults=5&serialNames=${enc}`;

  try {
    const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error(`FT HTTP ${r.status}: ${r.statusText}`);

    const data = await r.json();
    const result = extractLatestClose(data);

    if (!result) {
      // Return raw data so we can debug the structure
      return res.status(200).json({
        symbol,
        price: null,
        source: "FT.com",
        error: "Could not extract Close price from FT response",
        rawStructure: JSON.stringify(data).slice(0, 1000),
        fetchedAt: new Date().toISOString(),
      });
    }

    return res.status(200).json({
      symbol,
      price: result.price,
      dataPoints: result.count,
      source: "FT.com",
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(503).json({ error: e.message, symbol });
  }
};
