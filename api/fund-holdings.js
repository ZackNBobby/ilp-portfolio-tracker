// Vercel function — fetches fund holdings, asset/sector/geo allocation.
// Primary: Morningstar screener. Fallback: FT Markets tearsheet HTML scraping.

const TOKEN = "klr5zyak8x";
const UNIVERSE = "FOSGP%24%24ALL";

// FT Markets symbols for funds with known underlying ISINs
// Used as fallback when Morningstar has no data for a fund
const FUND_FT_SYMBOLS = {
  "Income Global Absolute Alpha Fund":          "LU2264538146:SGD",
  "Income World Healthscience Fund":            "LU1057294990:SGD",
  "Income India Equity Fund":                   "LU0536402901:SGD",
  "Income Regional China Fund":                 "IE0031814852:USD",
  "Income Global Growth Equity Fund":           "LU0690374615:EUR",
  "Income Global Emerging Markets Equity Fund": "LU0890818403:SGD",
  "Income Global Sustainable Fund":             "LU2279689827:SGD",
  "Income Global Dynamic Bond Fund":            "IE00B9HH6X13:SGD",
};

const FT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,*/*",
  "Accept-Language": "en-GB,en;q=0.9",
  "Referer": "https://markets.ft.com/",
};

// Parse holdings and allocations from the FT Markets tearsheet HTML
async function fetchFTHoldings(ftSymbol) {
  try {
    const url = `https://markets.ft.com/data/funds/tearsheet/holdings?s=${encodeURIComponent(ftSymbol)}`;
    const r = await fetch(url, { headers: FT_HEADERS, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const html = await r.text();

    // ── Top Holdings ──
    // FT embeds holdings in a table: each row has security name and weighting %
    const holdings = [];
    const tableMatch = html.match(/<table[^>]*class="[^"]*mod-tearsheet-holdings[^"]*"[^>]*>([\s\S]*?)<\/table>/i)
                    || html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
    if (tableMatch) {
      const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let rowM;
      while ((rowM = rowRe.exec(tableMatch[1])) !== null) {
        const cells = (rowM[1].match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || [])
          .map(c => c.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').trim())
          .filter(c => c.length > 0);
        if (cells.length < 2) continue;
        // Last numeric cell is usually the weighting %
        const pctStr = cells[cells.length - 1].replace('%','').trim();
        const pct = parseFloat(pctStr);
        const name = cells[0];
        if (!isNaN(pct) && pct > 0 && pct < 60 && name.length > 2 && !/^[\d.%]+$/.test(name)) {
          holdings.push({ name, pct: +pct.toFixed(2) });
        }
      }
    }

    // ── Asset Allocation via summary page ──
    let assetAlloc = {};
    try {
      const sumUrl = `https://markets.ft.com/data/funds/tearsheet/summary?s=${encodeURIComponent(ftSymbol)}`;
      const sr = await fetch(sumUrl, { headers: FT_HEADERS, signal: AbortSignal.timeout(12000) });
      if (sr.ok) {
        const sumHtml = await sr.text();
        // FT often has allocation in JSON embedded in <script> tags
        const jsonRe = /\{[^{}]*"(?:equity|bonds?|cash|fixed.?income)"[^{}]*\}/gi;
        let jm;
        while ((jm = jsonRe.exec(sumHtml)) !== null) {
          try {
            const obj = JSON.parse(jm[0]);
            for (const [k, v] of Object.entries(obj)) {
              const pv = parseFloat(v);
              if (!isNaN(pv) && pv > 0) {
                const key = k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g,' ');
                assetAlloc[key] = +pv.toFixed(2);
              }
            }
          } catch (_) {}
        }

        // Also try parsing allocation from summary table text
        const allocRe = /(?:equity|bonds?|fixed income|cash|alternatives?)[^\d]*([0-9]+\.?[0-9]*)\s*%/gi;
        let am;
        while ((am = allocRe.exec(sumHtml)) !== null) {
          const key = am[0].split('%')[0].replace(/[^a-zA-Z ]/g,'').trim();
          const pv = parseFloat(am[1]);
          if (!isNaN(pv) && pv > 0 && key.length > 2) {
            const label = key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
            if (!assetAlloc[label]) assetAlloc[label] = +pv.toFixed(2);
          }
        }
      }
    } catch (_) {}

    if (!holdings.length && !Object.keys(assetAlloc).length) return null;

    return {
      holdings: holdings.slice(0, 10),
      assetAlloc,
      sectorAlloc: {},
      geoAlloc: {},
      source: "FT Markets",
      asOf: new Date().toISOString().split("T")[0],
      ftSymbol,
    };
  } catch (e) {
    return null;
  }
}

// Mirrors fund-morningstar.js — update both when adding new SecIds
// secId → { secId, universe? } — universe defaults to UNIVERSE if not set
const FUND_SECIDS = {
  "Income Global Absolute Alpha Fund":          { secId: "F000016EDC" },
  "Income Global Dynamic Bond Fund":            { secId: "F00000PHFD" },
  "Income Global Gold Equity Fund":             { secId: "F0GBR04AR8" },
  "Income World Healthscience Fund":            { secId: "F0GBR04K8L" },
  "Income India Equity Fund":                   { secId: "F00000JTUS" },
  "Income Global Artificial Intelligence":      { secId: "F00000ZVQS" },
  "Income Global Emerging Markets Equity Fund": { secId: "F00000PN6R" },
  "Income Global Growth Equity Fund":           { secId: "F00001QUO9" },  // Manulife Fundsmith proxy
  "Income Regional China Fund":                 { secId: "F0HKG062N3" },
  "Income US Large Cap Equity Fund":            { secId: "F00001QUO7" },
  "Income Global Sustainable Fund":             { secId: "F000016LX1", universe: "FOEUR%24%24ALL" },
  "Income US Dividend and Growth Fund":         { secId: "F00000Q4B0" },
  // "Income Global Technology Fund" — Wellington direct ILP sub-fund; no underlying UCITS in any Morningstar universe
  // "Income Singapore Dividend Equity Fund" — Amova fund not in any Morningstar universe; uses staticHoldings only
};

const SCREENER_POINTS = [
  "SecId","Name","PortfolioDate",
  // Asset allocation — try both common Morningstar field name variants
  "AssetAllocCash","AssetAllocBond","AssetAllocStock","AssetAllocOther",
  "AssetAllocEquity","AssetAllocBondLong","AssetAllocCashLong",
  // Sector weights
  "SectorBasicMaterials","SectorCommunicationServices","SectorConsumerCyclical",
  "SectorConsumerDefensive","SectorEnergy","SectorFinancialServices",
  "SectorHealthcare","SectorIndustrials","SectorRealEstate","SectorTechnology","SectorUtilities",
  // Geographic weights
  "RegionAmericas","RegionGreaterAsia","RegionGreaterEurope","RegionMiddleEastAfrica",
].join(",");

const HEADERS = {
  "Accept": "application/json, */*",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Referer": "https://fundsingapore.com/",
};

function nonNull(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== 0 && !isNaN(v))
  );
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  const name = (req.query.name || "").trim();
  const mapping = FUND_SECIDS[name];

  if (!mapping) {
    // Try FT Markets as a fallback before giving up
    const ftSym = FUND_FT_SYMBOLS[name];
    if (ftSym) {
      const ftData = await fetchFTHoldings(ftSym);
      if (ftData) {
        return res.status(200).json({ noMapping: true, name, ftHoldings: ftData });
      }
    }
    return res.status(200).json({ noMapping: true, name,
      message: "Sub-fund not yet mapped. Add SecId in api/fund-holdings.js." });
  }

  const { secId, universe } = mapping;
  const pct = v => v != null && !isNaN(v) ? +parseFloat(v).toFixed(2) : null;
  const univ = universe || UNIVERSE;

  try {
    // Run holdings and allocation in parallel — max 4s each
    const [holdings, row] = await Promise.all([

      // ── HOLDINGS ──
      (async () => {
        const url = `https://lt.morningstar.com/api/rest.svc/${TOKEN}/security_details/${secId}`
          + `?viewId=holding&columnIds=HoldingRatioPortfolio%2CHoldingName%2CSectorName`
          + `&languageId=en-SG&currencyId=SGD&iType=3&holdType=all`;
        try {
          const hr = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(4000) });
          if (!hr.ok) return [];
          const text = await hr.text();
          if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) return [];
          const hd = JSON.parse(text);
          const list = hd?.Holding?.HoldingDetail || hd?.holding?.holdingDetail ||
            hd?.holdings || hd?.HoldingDetail || (Array.isArray(hd) ? hd : null) || [];
          return list
            .filter(h => (h.HoldingRatioPortfolio ?? h.weighting ?? h.weight) != null
                      && (h.HoldingName ?? h.securityName ?? h.name))
            .sort((a, b) => parseFloat(b.HoldingRatioPortfolio ?? b.weighting ?? b.weight ?? 0)
                          - parseFloat(a.HoldingRatioPortfolio ?? a.weighting ?? a.weight ?? 0))
            .slice(0, 10)
            .map(h => ({
              name: h.HoldingName ?? h.securityName ?? h.name ?? "",
              pct:  +parseFloat(h.HoldingRatioPortfolio ?? h.weighting ?? h.weight ?? 0).toFixed(2),
              sector: h.SectorName ?? h.sector ?? null,
            }));
        } catch { return []; }
      })(),

      // ── ALLOCATION: screener (fast ~1s, finds exact SecId when filter works) ──
      (async () => {
        const url = `https://lt.morningstar.com/api/rest.svc/${TOKEN}/security/screener`
          + `?outputType=json&languageId=en-SG`
          + `&securityDataPoints=${encodeURIComponent(SCREENER_POINTS)}`
          + `&universeIds=${univ}`
          + `&filters=${encodeURIComponent(`SecId in (${secId})`)}`;
        try {
          const sr = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(4000) });
          if (!sr.ok) return {};
          const sd = await sr.json();
          return (sd.rows || []).find(r => r.SecId === secId) || {};
        } catch { return {}; }
      })(),

    ]);

    return res.status(200).json({
      name, secId,
      morningstarName: row.Name || null,
      portfolioDate: row.PortfolioDate || null,
      assetAlloc: nonNull({
        "Equity":  pct(row.AssetAllocStock ?? row.AssetAllocEquity),
        "Bonds":   pct(row.AssetAllocBond  ?? row.AssetAllocBondLong),
        "Cash":    pct(row.AssetAllocCash  ?? row.AssetAllocCashLong),
        "Other":   pct(row.AssetAllocOther),
      }),
      sectorAlloc: nonNull({
        "Technology":          pct(row.SectorTechnology),
        "Healthcare":          pct(row.SectorHealthcare),
        "Financial Services":  pct(row.SectorFinancialServices),
        "Consumer Cyclical":   pct(row.SectorConsumerCyclical),
        "Communication":       pct(row.SectorCommunicationServices),
        "Industrials":         pct(row.SectorIndustrials),
        "Consumer Defensive":  pct(row.SectorConsumerDefensive),
        "Energy":              pct(row.SectorEnergy),
        "Basic Materials":     pct(row.SectorBasicMaterials),
        "Real Estate":         pct(row.SectorRealEstate),
        "Utilities":           pct(row.SectorUtilities),
      }),
      geoAlloc: nonNull({
        "Americas":          pct(row.RegionAmericas),
        "Greater Asia":      pct(row.RegionGreaterAsia),
        "Greater Europe":    pct(row.RegionGreaterEurope),
        "Middle East/Africa":pct(row.RegionMiddleEastAfrica),
      }),
      holdings,
      source: "Morningstar",
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(503).json({ error: e.message, name, secId });
  }
};
