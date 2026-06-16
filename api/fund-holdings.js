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
  const univDec = univ.replace(/%24%24/g, "$$$$");  // decoded for tools endpoint
  const debug = [];

  try {
    let row = {};
    let holdings = [];

    // ── HOLDINGS: tools.morningstar.co.uk (same domain that works for timeseries) ──
    const holdingAttempts = [
      // Format A — tools UK domain with bracket id format
      `https://tools.morningstar.co.uk/api/rest.svc/portfolio_holdings/${TOKEN}`
        + `?id=${secId}%5D2%5D0%5D${encodeURIComponent(univDec)}&languageId=en-SG&currencyId=SGD&outputType=json`,
      // Format B — lt domain security_details with holding viewId
      `https://lt.morningstar.com/api/rest.svc/${TOKEN}/security_details/${secId}`
        + `?viewId=holding&columnIds=HoldingRatioPortfolio%2CHoldingName%2CSectorName`
        + `&languageId=en-SG&currencyId=SGD&iType=3&holdType=all`,
      // Format C — lt domain with different column set
      `https://lt.morningstar.com/api/rest.svc/${TOKEN}/security_details/${secId}`
        + `?viewId=holding&columnIds=weighting%2CsecurityName%2Csector`
        + `&languageId=en-SG&currencyId=SGD&iType=3`,
    ];

    for (const url of holdingAttempts) {
      try {
        const hr = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
        debug.push(`holdings ${hr.status}: ${url.slice(0,80)}`);
        if (!hr.ok) continue;
        const text = await hr.text();
        // Log first 400 chars of body so we can see the actual structure
        debug.push(`holdings body: ${text.slice(0,400)}`);
        if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) continue;
        const hd = JSON.parse(text);
        // Log top-level keys
        debug.push(`holdings keys: ${Object.keys(hd).join(",")}`);
        // Try multiple response shape variants
        const list =
          hd?.Holding?.HoldingDetail ||
          hd?.holding?.holdingDetail ||
          hd?.holdings ||
          hd?.HoldingDetail ||
          (Array.isArray(hd) ? hd : null) || [];
        const parsed = list
          .filter(h => (h.HoldingRatioPortfolio ?? h.weighting ?? h.weight) != null && (h.HoldingName ?? h.securityName ?? h.name))
          .sort((a, b) => parseFloat(b.HoldingRatioPortfolio ?? b.weighting ?? b.weight ?? 0) - parseFloat(a.HoldingRatioPortfolio ?? a.weighting ?? a.weight ?? 0))
          .slice(0, 10)
          .map(h => ({
            name: h.HoldingName ?? h.securityName ?? h.name ?? "",
            pct:  +parseFloat(h.HoldingRatioPortfolio ?? h.weighting ?? h.weight ?? 0).toFixed(2),
            sector: h.SectorName ?? h.sector ?? null,
          }));
        if (parsed.length > 0) { holdings = parsed; break; }
      } catch (e) { debug.push(`holdings err: ${e.message}`); }
    }

    // ── ALLOCATION: tools.morningstar.co.uk snapshot + screener fallback ──
    const allocAttempts = [
      // Format A — tools UK domain snapshot (bracket id format, same as timeseries)
      `https://tools.morningstar.co.uk/api/rest.svc/fund_snapshot/${TOKEN}`
        + `?id=${secId}%5D2%5D0%5D${encodeURIComponent(univDec)}&languageId=en-SG&currencyId=SGD&outputType=json`,
      // Format B — lt domain snapshot viewId
      `https://lt.morningstar.com/api/rest.svc/${TOKEN}/security_details/${secId}`
        + `?viewId=snapshot&languageId=en-SG&currencyId=SGD&iType=3`,
      // Format C — screener WITHOUT universeIds — universe param may be swallowing SecId filter
      `https://lt.morningstar.com/api/rest.svc/${TOKEN}/security/screener`
        + `?outputType=json&languageId=en-SG`
        + `&securityDataPoints=${encodeURIComponent(SCREENER_POINTS)}`
        + `&filters=${encodeURIComponent(`SecId in (${secId})`)}`,
      // Format D — screener with id= direct param (no filters= syntax)
      `https://lt.morningstar.com/api/rest.svc/${TOKEN}/security/screener`
        + `?outputType=json&languageId=en-SG`
        + `&securityDataPoints=${encodeURIComponent(SCREENER_POINTS)}`
        + `&universeIds=${univ}`
        + `&id=${secId}`,
    ];

    for (const url of allocAttempts) {
      try {
        const sr = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
        debug.push(`alloc ${sr.status}: ${url.slice(0,80)}`);
        if (!sr.ok) continue;
        const text = await sr.text();
        // Log 1500 chars so we can see the full XML structure for snapshot
        debug.push(`alloc body: ${text.slice(0,1500)}`);
        if (!text.trim().startsWith("{") && !text.trim().startsWith("<")) continue;
        let sd;
        if (text.trim().startsWith("{")) {
          sd = JSON.parse(text);
          debug.push(`alloc keys: ${Object.keys(sd).join(",")}`);
        } else {
          // XML — log all tag names present so we know what fields to parse
          const tagNames = [...new Set([...text.matchAll(/<([A-Za-z][A-Za-z0-9_]+)[\s/>]/g)].map(m=>m[1]))];
          debug.push(`alloc xml tags: ${tagNames.join(",")}`);
          sd = { _xml: text };
        }

        // Screener format: {rows:[{SecId, AssetAllocStock,...}]}
        if (sd.rows) {
          const matched = (sd.rows || []).find(r => r.SecId === secId);
          if (matched) { row = matched; break; }
          continue;
        }
        // Snapshot / fund_snapshot formats — try several shapes
        const alloc =
          sd?.Portfolios?.[0]?.PortfolioStatistics ||
          sd?.portfolioStatistics ||
          sd?.AssetAllocation ||
          sd?.assetAllocation || {};
        // Map known field names into our row shape
        const fieldMap = {
          AssetAllocEquity: ['AssetAllocEquity','AssetAllocStock','equity','Equity'],
          AssetAllocBond:   ['AssetAllocBond','AssetAllocBondLong','bond','Bond','fixedIncome'],
          AssetAllocCash:   ['AssetAllocCash','AssetAllocCashLong','cash','Cash'],
          AssetAllocOther:  ['AssetAllocOther','other','Other'],
        };
        let found = false;
        for (const [out, candidates] of Object.entries(fieldMap)) {
          for (const c of candidates) {
            if (alloc[c] != null) { row[out] = alloc[c]; found = true; break; }
          }
        }
        // Also try sector from snapshot
        const sectors = sd?.Portfolios?.[0]?.GlobalStockSector || sd?.GlobalStockSector || [];
        if (Array.isArray(sectors) && sectors.length) {
          const sMap = {SectorConsumerCyclical:'ConsumerCyclical',SectorFinancialServices:'FinancialServices',
            SectorHealthcare:'Healthcare',SectorIndustrials:'Industrials',SectorTechnology:'Technology',
            SectorCommunicationServices:'CommunicationServices',SectorConsumerDefensive:'ConsumerDefensive',
            SectorEnergy:'Energy',SectorBasicMaterials:'BasicMaterials',SectorRealEstate:'RealEstate',SectorUtilities:'Utilities'};
          for (const s of sectors) {
            const key = Object.keys(sMap).find(k => sMap[k] === s.Type || sMap[k] === s.type);
            if (key && (s.SectorWeighting ?? s.weighting) != null) row[key] = s.SectorWeighting ?? s.weighting;
          }
        }
        if (found) break;
      } catch (e) { debug.push(`alloc err: ${e.message}`); }
    }

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
      _debug: debug,  // remove once working
    });
  } catch (e) {
    return res.status(503).json({ error: e.message, name, secId });
  }
};
