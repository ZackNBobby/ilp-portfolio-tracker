// Fetches the latest price for an underlying institutional fund.
// FT.com mode: ?symbol=LU2264538146:SGD (ISIN:currency, for European-domiciled UCITS)
// Morningstar mode: ?symbol=ms:F00000Q3EG (ms:<SecId>, for SG-domiciled funds not on FT.com)

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-GB,en;q=0.9",
  "Origin": "https://markets.ft.com",
  "Referer": "https://markets.ft.com/data/funds/tearsheet/charts",
};

// FT chartapi/series response (POST):
//   { Data: [{ Elements: [{ Type:"price", ComponentSeries: [{Type:"Close", Values:[...]}] }] }] }
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

// Try fetching the FT tearsheet HTML and parsing the NAV/price from it
async function fetchFromHtmlPage(symbol) {
  const url = `https://markets.ft.com/data/funds/tearsheet/summary?s=${encodeURIComponent(symbol)}`;
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`FT page HTTP ${r.status}`);
  const html = await r.text();

  // Try several price patterns found in FT tearsheet pages
  const patterns = [
    // "Price (SGD) 19.62" or similar text
    /price\s*\((?:sgd|usd|eur)\)[^0-9]*([0-9]+\.[0-9]{2,6})/gi,
    // data-value="19.615703" or similar
    /data-value="([0-9]+\.[0-9]{2,6})"/g,
    // NAV: 19.615703
    /(?:nav|price|bid)[^\d]{0,20}([0-9]+\.[0-9]{4,8})/gi,
    // JSON in script: "price":19.615703
    /"(?:price|nav|close|value)"\s*:\s*([0-9]+\.[0-9]{4,8})/gi,
  ];

  for (const re of patterns) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(html)) !== null) {
      const p = parseFloat(m[1]);
      if (p > 0.05 && p < 10000) return p;
    }
  }
  throw new Error("Could not find price in FT page HTML");
}

const MS_TOKEN = "klr5zyak8x";
const MS_HEADERS = {
  "Accept": "application/json, */*",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Referer": "https://fundsingapore.com/",
};

// Fetch the latest NAV from Morningstar timeseries_price endpoint for SG-domiciled funds
async function fetchMorningstarLatest(secId) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 45); // 45 days back to ensure we get at least one trading day
  const start = startDate.toISOString().split("T")[0];
  const universe = "FOSGP%24%24ALL";
  const url = `https://tools.morningstar.co.uk/api/rest.svc/timeseries_price/${MS_TOKEN}`
    + `?id=${secId}]2]0]${decodeURIComponent(universe)}`
    + `&currencyId=SGD&idtype=Morningstar&frequency=daily`
    + `&startDate=${start}&outputType=json`;

  const r = await fetch(url, { headers: MS_HEADERS, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Morningstar timeseries HTTP ${r.status}`);
  const data = await r.json();
  const history = data?.TimeSeries?.Security?.[0]?.HistoryDetail || [];
  if (!history.length) throw new Error("No Morningstar price history returned");

  // Take the most recent entry
  const sorted = history
    .map(h => ({ date: h.EndDate, price: parseFloat(h.Value) }))
    .filter(h => h.date && !isNaN(h.price) && h.price > 0)
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!sorted.length) throw new Error("No valid Morningstar price entries");

  return { price: sorted[0].price, date: sorted[0].date };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  res.setHeader("Cache-Control", "s-maxage=14400, stale-while-revalidate=86400");

  const symbol = (req.query.symbol || "").trim();
  if (!symbol) return res.status(400).json({ error: "Missing ?symbol= parameter (e.g. LU2264538146:SGD or ms:F00000Q3EG)" });

  // Morningstar pathway: symbol starts with "ms:"
  if (symbol.startsWith("ms:")) {
    const secId = symbol.slice(3).trim();
    if (!secId) return res.status(400).json({ error: "Missing SecId after ms: prefix" });
    try {
      const result = await fetchMorningstarLatest(secId);
      return res.status(200).json({
        symbol, price: result.price, asOf: result.date,
        source: "Morningstar timeseries", fetchedAt: new Date().toISOString(),
      });
    } catch (e) {
      return res.status(503).json({ error: e.message, symbol });
    }
  }

  const enc = encodeURIComponent(symbol);

  // Strategy 1: POST to FT chart API (correct method — GET returns 400)
  try {
    const body = {
      days: 30,
      dataNormalized: false,
      dataPeriod: "Day",
      dataInterval: 1,
      realTimeData: false,
      closingTimesBands: false,
      numberofResults: 5,
      serialNames: [symbol],
      resolution: "1D",
    };
    const r = await fetch("https://markets.ft.com/data/chartapi/series", {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
    if (r.ok) {
      const data = await r.json();
      const result = extractLatestClose(data);
      if (result) {
        return res.status(200).json({
          symbol, price: result.price, dataPoints: result.count,
          source: "FT.com chart API (POST)", fetchedAt: new Date().toISOString(),
        });
      }
    }
  } catch (e) {}

  // Strategy 2: GET with alternative parameter format
  try {
    const url = `https://markets.ft.com/data/chartapi/series?days=30&dataNormalized=false&dataPeriod=Day&dataInterval=1&realTimeData=false&closingTimesBands=false&numberofResults=5&serialNames=${symbol}&resolution=1D`;
    const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
    if (r.ok) {
      const data = await r.json();
      const result = extractLatestClose(data);
      if (result) {
        return res.status(200).json({
          symbol, price: result.price, dataPoints: result.count,
          source: "FT.com chart API (GET)", fetchedAt: new Date().toISOString(),
        });
      }
    }
  } catch (e) {}

  // Strategy 3: Scrape the fund tearsheet HTML page
  try {
    const price = await fetchFromHtmlPage(symbol);
    return res.status(200).json({
      symbol, price, source: "FT.com HTML page", fetchedAt: new Date().toISOString(),
    });
  } catch (e) {}

  return res.status(503).json({
    error: "Could not fetch underlying fund price from FT.com. All strategies failed.",
    symbol,
    tip: "Check the ISIN and currency at markets.ft.com — the symbol should match the ?s= parameter in the URL.",
  });
};
