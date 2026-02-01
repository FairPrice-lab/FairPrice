const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { kind } = req.body || {}; // "once" | "sub"
    const isSub = kind === "sub";

    const priceId = isSub ? process.env.STRIPE_PRICE_SUB : process.env.STRIPE_PRICE_ONCE;
    if (!priceId) return res.status(400).json({ error: "Missing price id env var" });

    const origin = req.headers.origin || `https://${req.headers.host}`;

    const session = await stripe.checkout.sessions.create({
      mode: isSub ? "subscription" : "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/`
    });

    return res.status(200).json({ url: session.url });
  } catch (e) {
    return res.status(500).json({ error: "Stripe session error", detail: String(e?.message || e) });
  }
};
