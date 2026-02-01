const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function classify(price, median){
  const r = price / median;
  const score = clamp((r - 0.8) / (1.4 - 0.8), 0, 1); // 0=under, 0.5=fair, 1=over
  let label = "fair";
  if (r < 0.9) label = "under";
  else if (r > 1.15) label = "over";
  return { ratio: r, score, label };
}

function marginEstimate(ratio){
  if (ratio < 0.95) return "Low–normal (estimated 10–20%)";
  if (ratio < 1.10) return "Normal (estimated 15–30%)";
  if (ratio < 1.25) return "High (estimated 25–45%)";
  return "Very high (estimated 40–60%+)";
}

function tipsFor(label){
  if (label === "over") return "Ask for itemized breakdown, get 2 more bids, and request lower-cost alternatives.";
  if (label === "under") return "Confirm scope, exclusions, warranty, and change-order terms to avoid surprise add-ons.";
  return "Confirm scope + warranty, and ask what’s included/excluded before approving.";
}

// Category medians (single default, no scale)
function baseMedian(category){
  const base = {
    "Home services (repairs/visit)":     1800,
    "Home projects (install/remodel)":   4500,
    "Auto (repair/body)":                1400,
    "Medical (out-of-pocket)":           1200,
    "Moving / logistics":                1600,
    "Professional services":             2500,
    "Bills / recurring charges":          350,
    "Other":                             2000
  };
  return base[category] ?? base.Other;
}

// ZIP→region (simple)
function regionFromZip(zip){
  if (!zip || zip.length < 1) return "National";
  const d = zip[0];
  if (["0","1","2"].includes(d)) return "Northeast";
  if (["3","4","5"].includes(d)) return "South";
  if (["6","7"].includes(d)) return "Midwest";
  if (["8","9"].includes(d)) return "West";
  return "National";
}

// BLS CPI series
const CPI_SERIES = {
  National:  "CUUR0000SA0",
  Northeast: "CUUR0100SA0",
  Midwest:   "CUUR0200SA0",
  South:     "CUUR0300SA0",
  West:      "CUUR0400SA0"
};

// Cache CPI to reduce calls
const cpiCache = new Map();
const CACHE_MS = 60 * 60 * 1000;

async function fetchLatestCPI(seriesId){
  const key = `cpi:${seriesId}`;
  const now = Date.now();
  const cached = cpiCache.get(key);
  if (cached && (now - cached.ts) < CACHE_MS) return cached.value;

  const y = new Date().getFullYear();
  const startyear = String(y - 2);
  const endyear = String(y);

  const res = await fetch("https://api.bls.gov/publicAPI/v2/timeseries/data/", {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ seriesid: [seriesId], startyear, endyear })
  });

  const data = await res.json();
  const series = data?.Results?.series?.[0];
  const point = series?.data?.[0];
  const value = point?.value ? Number(point.value) : null;

  cpiCache.set(key, { value, ts: now });
  return value;
}

async function cpiMultipliers(zip){
  const region = regionFromZip(zip);
  const natId = CPI_SERIES.National;
  const regId = CPI_SERIES[region] || CPI_SERIES.National;

  const [nat, reg] = await Promise.all([
    fetchLatestCPI(natId),
    fetchLatestCPI(regId)
  ]);

  if (!nat || !reg) {
    return { region, localMult: 1.0, stateMult: 1.0, nationalMult: 1.0, note: "BLS CPI unavailable; neutral multipliers used." };
  }

  const ratio = reg / nat;
  return { region, localMult: ratio, stateMult: ratio, nationalMult: 1.0, note: "Adjusted using BLS CPI (region vs national)." };
}

async function verifyAccess(sessionId) {
  if (!sessionId) return { ok:false };

  const s = await stripe.checkout.sessions.retrieve(sessionId);

  if (s.mode === "payment" && s.payment_status === "paid") {
    return { ok:true, access:"once" };
  }

  if (s.mode === "subscription" && s.status === "complete" && s.subscription) {
    const sub = await stripe.subscriptions.retrieve(String(s.subscription));
    if (sub && (sub.status === "active" || sub.status === "trialing")) {
      return { ok:true, access:"sub" };
    }
  }

  return { ok:false };
}

module.exports = async function handler(req, res){
  if (req.method !== "POST") return res.status(405).json({ error:"POST only" });

  try{
    const { mode, session_id, category, zip, price } = req.body || {};

    const p = Number(price);
    const havePrice = !Number.isNaN(p) && p > 0;

    if (!havePrice && mode !== "full") {
      return res.status(200).json({
        label: "needs price",
        score: 0.5,
        message: "Add the total quoted price to get an under/fair/over signal."
      });
    }

    const cpi = await cpiMultipliers(zip);
    const base = baseMedian(category);
    const localMedian = base * cpi.localMult;

    const cls = classify(p, localMedian);

    // Preview: no $ benchmarks
    if (mode !== "full") {
      const msg =
        cls.label === "over"  ? "Likely OVER typical pricing for your area. Unlock the full report for benchmarks and negotiation levers."
      : cls.label === "under" ? "Likely UNDER typical pricing. Unlock the full report to see what to double-check."
      : "Likely FAIR. Unlock the full report for the benchmark range and next steps.";

      return res.status(200).json({ label: cls.label, score: cls.score, message: msg });
    }

    // Full requires paid session
    const access = await verifyAccess(session_id);
    if (!access.ok) return res.status(403).json({ error:"Payment required." });

    const low = localMedian * 0.85;
    const high = localMedian * 1.20;

    const diffPct = Math.round(Math.abs((cpi.localMult - 1) * 100));
    const direction = cpi.localMult >= 1 ? "higher" : "lower";

    const marketComparison =
      `Local (${cpi.region}) baseline is ~${diffPct}% ${direction} than national (CPI-adjusted). State baseline is approximated from region.`;

    return res.status(200).json({
      label: cls.label,
      score: cls.score,
      access: access.access,
      full_report: {
        market_comparison: marketComparison,
        estimated_margin: marginEstimate(cls.ratio),
        price_range: `Estimated fair range (local): ~$${Math.round(low).toLocaleString()} – $${Math.round(high).toLocaleString()}`,
        tips: tipsFor(cls.label),
        data_note: `Data note: ${cpi.note} Source: U.S. Bureau of Labor Statistics CPI via Public Data API.`
      }
    });

  } catch(e){
    return res.status(500).json({ error:"Server error", detail:String(e?.message || e) });
  }
};
