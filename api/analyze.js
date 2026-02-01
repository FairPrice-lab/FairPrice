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
  // Simple, non-precise bands (avoid over-claiming)
  if (ratio < 0.95) return "Low–normal (estimated 10–20%)";
  if (ratio < 1.10) return "Normal (estimated 15–30%)";
  if (ratio < 1.25) return "High (estimated 25–45%)";
  return "Very high (estimated 40–60%+)";
}

function tipsFor(label){
  if (label === "over") {
    return "Ask for itemized breakdown (labor hours/materials), get 2 more bids, and request lower-cost alternatives.";
  }
  if (label === "under") {
    return "Confirm scope, exclusions, warranty, and change-order terms to avoid surprise add-ons.";
  }
  return "Confirm scope + warranty, and ask what’s included/excluded before approving.";
}

// Broad category baselines (national-ish before CPI adjustment)
// These are deliberately rough. CPI provides regional adjustment.
function baseMedian(category, scale){
  const base = {
    "Home services (repairs/visit)":     { small: 450,  medium: 1800, large: 8500 },
    "Home projects (install/remodel)":   { small: 900,  medium: 4500, large: 22000 },
    "Auto (repair/body)":                { small: 300,  medium: 1400, large: 6000 },
    "Medical (out-of-pocket)":           { small: 250,  medium: 1200, large: 5000 },
    "Moving / logistics":                { small: 350,  medium: 1600, large: 7500 },
    "Professional services":             { small: 500,  medium: 2500, large: 12000 },
    "Bills / recurring charges":         { small: 120,  medium: 350,  large: 1200 },
    "Other":                             { small: 500,  medium: 2000, large: 9000 }
  };
  const cat = base[category] ? category : "Other";
  const sc = (scale === "small" || scale === "large") ? scale : "medium";
  return base[cat][sc] || base[cat].medium;
}

// Simple region guess from ZIP first digit (fast, no extra dataset required)
function regionFromZip(zip){
  if (!zip || zip.length < 1) return "National";
  const d = zip[0];
  if (["0","1","2"].includes(d)) return "Northeast";
  if (["3","4","5"].includes(d)) return "South";
  if (["6","7"].includes(d)) return "Midwest";
  if (["8","9"].includes(d)) return "West";
  return "National";
}

// BLS CPI series IDs
const CPI_SERIES = {
  National:  "CUUR0000SA0",
  Northeast: "CUUR0100SA0",
  Midwest:   "CUUR0200SA0",
  South:     "CUUR0300SA0",
  West:      "CUUR0400SA0"
};

// Tiny in-memory cache to reduce BLS calls (best-effort)
const cpiCache = new Map(); // key -> { value, ts }
const CACHE_MS = 60 * 60 * 1000; // 1 hour

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
  const point = series?.data?.[0]; // most recent
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
    return {
      region,
      localMult: 1.0,
      stateMult: 1.0,  // approximated
      nationalMult: 1.0,
      note: "BLS CPI unavailable at the moment; used neutral multipliers."
    };
  }

  const ratio = reg / nat;
  return {
    region,
    localMult: ratio,
    stateMult: ratio,     // “state/region baseline” approximation
    nationalMult: 1.0,
    note: "Benchmarks adjusted using BLS CPI (region vs national)."
  };
}

async function verifyAccess(sessionId) {
  if (!sessionId) return { ok:false };

  const s = await stripe.checkout.sessions.retrieve(sessionId);

  // One-time
  if (s.mode === "payment" && s.payment_status === "paid") {
    return { ok:true, access:"once" };
  }

  // Subscription (verify active/trialing)
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
    const body = req.body || {};
    const { mode, session_id, category, scale="medium", zip, price, quoteText } = body;

    const p = Number(price);
    const havePrice = !Number.isNaN(p) && p > 0;

    // Preview requires price for meaningful signal (keeps it simple)
    if (!havePrice && mode !== "full") {
      return res.status(200).json({
        label: "needs price",
        score: 0.5,
        message: "Add the total price to get an under/fair/over signal (preview keeps benchmark numbers hidden)."
      });
    }

    const cpi = await cpiMultipliers(zip);
    const base = baseMedian(category, scale);

    const localMedian = base * cpi.localMult;
    const stateMedian = base * cpi.stateMult;
    const nationalMedian = base * cpi.nationalMult;

    const cls = classify(p, localMedian);

    // FREE preview: no benchmark dollars
    if (mode !== "full") {
      const msg =
        cls.label === "over"  ? "Likely OVER typical pricing for your area. Full report shows benchmark range + negotiation levers."
      : cls.label === "under" ? "Likely UNDER typical pricing. Full report shows what to double-check to avoid surprises."
      : "Likely FAIR. Full report shows local/state/national comparison and estimated margin band.";

      return res.status(200).json({
        label: cls.label,
        score: cls.score,
        message: msg
      });
    }

    // FULL requires payment verification
    const access = await verifyAccess(session_id);
    if (!access.ok) return res.status(403).json({ error:"Payment required." });

    // Simple fair range around local baseline
    const low = localMedian * 0.85;
    const high = localMedian * 1.20;

    const diffPct = Math.round(Math.abs((cpi.localMult - 1) * 100));
    const direction = cpi.localMult >= 1 ? "higher" : "lower";

    const marketComparison =
      `Local (${cpi.region}) baseline is ~${diffPct}% ${direction} than national. ` +
      `State baseline is approximated from your region; national is the reference baseline.`;

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
