// Debug: download Income's JS bundles and search for price API URLs

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "*/*",
  "Accept-Language": "en-SG,en-GB;q=0.9,en;q=0.8",
  "Referer": "https://www.income.com.sg/",
};

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const slug = "income-global-dynamic-bond-fund";

  // 1. Fetch the fund page HTML
  const pageR = await fetch(`https://www.income.com.sg/funds/${slug}`, {
    headers: HEADERS, signal: AbortSignal.timeout(12000),
  });
  const html = await pageR.text();

  // 2. Extract all <script src="..."> URLs
  const scriptSrcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
    .map(m => m[1])
    .filter(s => s.includes(".js"))
    .map(s => s.startsWith("http") ? s : `https://www.income.com.sg${s}`);

  // 3. Also check for inline data or config objects
  const inlineScripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1].trim())
    .filter(s => s.length > 20);

  // Look for API endpoint hints in inline scripts
  const inlineApiHints = [];
  for (const script of inlineScripts) {
    const urls = [...script.matchAll(/["'`](https?:\/\/[^"'`\s]{5,100})["'`]/g)].map(m => m[1]);
    const paths = [...script.matchAll(/["'`](\/[a-zA-Z0-9/_-]{4,60})["'`]/g)].map(m => m[1]);
    if (urls.length || paths.length) inlineApiHints.push({ snippet: script.slice(0, 200), urls, paths });
  }

  // 4. Search a sample of JS bundles for price/nav/bid API patterns
  const bundleFindings = [];
  const PRICE_PATTERNS = [
    /["'`](https?:\/\/[^"'`\s]*(?:price|nav|bid|fund)[^"'`\s]{0,60})["'`]/gi,
    /["'`](\/(?:api|v\d)\/[^"'`\s]*(?:price|nav|bid|fund)[^"'`\s]{0,60})["'`]/gi,
    /(?:endpoint|baseUrl|apiUrl|host)\s*[:=]\s*["'`]([^"'`\s]{5,80})["'`]/gi,
  ];

  // Only check the first 5 bundles to stay within timeout
  for (const src of scriptSrcs.slice(0, 5)) {
    try {
      const r = await fetch(src, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const js = await r.text();
      const matches = [];
      for (const pat of PRICE_PATTERNS) {
        pat.lastIndex = 0;
        let m;
        while ((m = pat.exec(js)) !== null) {
          matches.push(m[1]);
          if (matches.length > 30) break;
        }
      }
      if (matches.length > 0) {
        bundleFindings.push({ src, matches: [...new Set(matches)].slice(0, 30) });
      }
    } catch (e) {
      bundleFindings.push({ src, error: e.message });
    }
  }

  res.status(200).json({
    pageStatus: pageR.status,
    scriptSrcs,
    inlineApiHints,
    bundleFindings,
    totalScripts: scriptSrcs.length,
  });
};
