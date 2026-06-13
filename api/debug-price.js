// Debug endpoint — call /api/debug-price to see raw data from Income's ISR JSON
// for one fund. Helps identify the exact field name that holds the price.
// Remove or protect this file before sharing publicly.

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const slug = req.query.slug || "income-global-dynamic-bond-fund";

  const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-SG,en-GB;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
  };

  // 1. Get buildId
  const homeR = await fetch("https://www.income.com.sg/", { headers: HEADERS, signal: AbortSignal.timeout(10000) });
  const homeHtml = await homeR.text();
  const buildIdMatch = homeHtml.match(/"buildId"\s*:\s*"([^"]+)"/);
  const buildId = buildIdMatch ? buildIdMatch[1] : null;

  // 2. Fetch ISR JSON
  let isrData = null, isrError = null;
  if (buildId) {
    try {
      const isrUrl = `https://www.income.com.sg/_next/data/${buildId}/funds/${slug}.json`;
      const isrR = await fetch(isrUrl, { headers: { ...HEADERS, Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
      isrData = isrR.ok ? await isrR.json() : { status: isrR.status, statusText: isrR.statusText };
    } catch (e) { isrError = e.message; }
  }

  // 3. Fetch raw page and return __NEXT_DATA__
  let pageNextData = null, pageError = null;
  try {
    const pageR = await fetch(`https://www.income.com.sg/funds/${slug}`, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
    const html = await pageR.text();
    const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    pageNextData = m ? JSON.parse(m[1]) : { error: "__NEXT_DATA__ not found" };
  } catch (e) { pageError = e.message; }

  res.status(200).json({ buildId, isrData, isrError, pageNextData, pageError });
};
