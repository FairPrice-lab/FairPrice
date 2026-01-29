const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      { price: process.env.STRIPE_PRICE_ONCE, quantity: 1 }
    ],
    success_url: `${req.headers.origin}/`,
    cancel_url: `${req.headers.origin}/`
  });

  res.status(200).json({ url: session.url });
};
