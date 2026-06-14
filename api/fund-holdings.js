// Vercel function — fetches fund holdings, asset/sector/geo allocation from Morningstar screener.
// Top 10 holdings attempted via portfolio endpoint (may be blocked; allocation always available).

const TOKEN = "klr5zyak8x";
const UNIVERSE = "FOSGP%24%24ALL";

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
  // "Income Global Technology Fund" — Wellington direct ILP sub-fund; no underlying UCITS in any Morningstar universe
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
  res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=172800");

  const name = (req.query.name || "").trim();
  const mapping = FUND_SECIDS[name];

  if (!mapping) {
    return res.status(200).json({ noMapping: true, name,
      message: "Sub-fund not yet mapped. Add SecId in api/fund-holdings.js." });
  }

  const { secId, universe } = mapping;

  try {
    // — Screener call: allocation data points —
    const screenerUrl = `https://lt.morningstar.com/api/rest.svc/${TOKEN}/security/screener`
      + `?outputType=json&languageId=en-SG`
      + `&securityDataPoints=${encodeURIComponent(SCREENER_POINTS)}`
      + `&universeIds=${universe || UNIVERSE}`
      + `&filters=${encodeURIComponent(`SecId in (${secId})`)}`;

    const sr = await fetch(screenerUrl, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
    if (!sr.ok) throw new Error(`Screener HTTP ${sr.status}`);
    const sd = await sr.json();
    const row = sd.rows?.[0] || {};

    // — Portfolio holdings call (may return empty if Morningstar blocks it) —
    let holdings = [];
    try {
      const holdUrl = `https://lt.morningstar.com/api/rest.svc/${TOKEN}/security_details/${secId}`
        + `?viewId=holding&columnIds=HoldingRatioPortfolio%2CHoldingName%2CSectorName`
        + `&languageId=en-SG&currencyId=SGD&iType=3&holdType=all`;
      const hr = await fetch(holdUrl, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
      if (hr.ok) {
        const text = await hr.text();
        // Morningstar sometimes returns XML-like or JSON
        if (text.trim().startsWith("{")) {
          const hd = JSON.parse(text);
          const list = hd?.Holding?.HoldingDetail || hd?.holding?.holdingDetail || [];
          holdings = list
            .filter(h => h.HoldingRatioPortfolio != null && h.HoldingName)
            .sort((a, b) => parseFloat(b.HoldingRatioPortfolio) - parseFloat(a.HoldingRatioPortfolio))
            .slice(0, 10)
            .map(h => ({ name: h.HoldingName, pct: +parseFloat(h.HoldingRatioPortfolio).toFixed(2), sector: h.SectorName || null }));
        }
      }
    } catch (_) { /* holdings endpoint blocked or unavailable */ }

    const pct = v => v != null && !isNaN(v) ? +parseFloat(v).toFixed(2) : null;

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
