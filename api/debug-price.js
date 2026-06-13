// Debug: fetch the funds-details widget JS and extract the price API URL

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "*/*",
  "Accept-Language": "en-SG,en-GB;q=0.9,en;q=0.8",
  "Referer": "https://www.income.com.sg/",
};

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const slug = req.query.slug || "income-global-dynamic-bond-fund";

  // 1. Get the fund page to find the exact versioned URL of funds-details.js
  const pageR = await fetch(`https://www.income.com.sg/funds/${slug}`, {
    headers: HEADERS, signal: AbortSignal.timeout(12000),
  });
  const html = await pageR.text();

  const allScripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
  const fundsDetailsSrc = allScripts.find(s => s.includes("funds-details"));
  const fundsPriceSrc = allScripts.find(s => s.includes("fund-price") || s.includes("fundprice"));

  const results = { allScripts, fundsDetailsSrc, fundsPriceSrc };

  // 2. Fetch funds-details.js and extract anything URL-like
  if (fundsDetailsSrc) {
    try {
      const url = fundsDetailsSrc.startsWith("http") ? fundsDetailsSrc : `https://www.income.com.sg${fundsDetailsSrc}`;
      const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
      const js = await r.text();

      // Extract all string literals that look like URLs or API paths
      const httpUrls   = [...js.matchAll(/["'`](https?:\/\/[^"'`\s\\]{5,120})["'`]/g)].map(m => m[1]);
      const apiPaths   = [...js.matchAll(/["'`](\/[a-zA-Z0-9._\-/]{5,80})["'`]/g)].map(m => m[1])
                          .filter(p => /api|price|nav|bid|fund|data|json|endpoint/i.test(p));
      const fetchCalls = [...js.matchAll(/fetch\s*\(\s*[^,)]{3,120}/g)].map(m => m[0].slice(0, 120));
      const ajaxCalls  = [...js.matchAll(/(?:ajax|get|post)\s*\(\s*[^,)]{3,120}/g)].map(m => m[0].slice(0, 120));
      const xhrOpen    = [...js.matchAll(/\.open\s*\([^)]{5,120}\)/g)].map(m => m[0]);

      results.fundsDetailsJs = {
        size: js.length,
        httpUrls: [...new Set(httpUrls)].slice(0, 40),
        apiPaths: [...new Set(apiPaths)].slice(0, 40),
        fetchCalls: [...new Set(fetchCalls)].slice(0, 20),
        ajaxCalls: [...new Set(ajaxCalls)].slice(0, 20),
        xhrOpen: [...new Set(xhrOpen)].slice(0, 20),
        // Also grab a snippet around "price" or "nav" or "bid" keywords
        priceContext: [],
      };

      // Find context around price/nav/bid mentions
      for (const kw of ["price", "bidNav", "navPrice", "unitPrice", "bid_nav"]) {
        let idx = js.toLowerCase().indexOf(kw.toLowerCase());
        while (idx !== -1 && results.fundsDetailsJs.priceContext.length < 20) {
          results.fundsDetailsJs.priceContext.push(js.slice(Math.max(0, idx - 80), idx + 120));
          idx = js.toLowerCase().indexOf(kw.toLowerCase(), idx + 1);
        }
      }
    } catch (e) {
      results.fundsDetailsError = e.message;
    }
  }

  // 3. Also check the funds-list widget in case it has price data
  const fundsListSrc = allScripts.find(s => s.includes("funds-details") || s.includes("fund-list") || s.includes("funds-list"));
  if (fundsListSrc && fundsListSrc !== fundsDetailsSrc) {
    results.fundsListSrc = fundsListSrc;
  }

  res.status(200).json(results);
};
