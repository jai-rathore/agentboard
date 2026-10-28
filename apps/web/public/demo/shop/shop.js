// Mock store shared code: catalog + a localStorage cart. Nothing leaves the page; no payment.
const CATALOG = [
  ["Ethiopia Yirgacheffe", 18, "Whole beans · light roast"], ["Colombia Huila", 16, "Whole beans · medium roast"],
  ["Sumatra Mandheling", 17, "Whole beans · dark roast"], ["Kenya AA", 21, "Whole beans · light roast"],
  ["Guatemala Antigua", 15, "Whole beans · medium roast"], ["Brazil Santos", 12, "Whole beans · medium roast"],
  ["Decaf Mexico Chiapas", 14, "Whole beans · decaf"], ["House Espresso Blend", 13, "Whole beans · espresso"],
  ["Pour-over Dripper", 24, "Brewing gear"], ["Burr Grinder", 89, "Brewing gear"],
  ["Paper Filters (100)", 6, "Brewing gear"], ["Gooseneck Kettle", 45, "Brewing gear"],
].map(([name, price, cat], i) => ({ id: `p${i + 1}`, name, price, cat }));
const COUPONS = { BEANS10: { label: "10% off", off: (s) => Math.round(s * 10) / 100 }, WELCOME5: { label: "$5 off orders of $30+", off: (s) => (s >= 30 ? 5 : null) } };
const cart = { get: () => JSON.parse(localStorage.getItem("bt_cart") ?? "[]"), set: (c) => localStorage.setItem("bt_cart", JSON.stringify(c)) };
const coupon = { get: () => localStorage.getItem("bt_coupon"), set: (c) => (c ? localStorage.setItem("bt_coupon", c) : localStorage.removeItem("bt_coupon")) };
const money = (x) => `$${x.toFixed(2)}`;
function addToCart(id) { const c = cart.get(); const it = c.find((x) => x.id === id); if (it) it.qty++; else c.push({ id, qty: 1 }); cart.set(c); badge(); }
function lines() { return cart.get().map((x) => ({ ...CATALOG.find((p) => p.id === x.id), qty: x.qty })).filter((x) => x.name); }
function totals() {
  const subtotal = lines().reduce((s, l) => s + l.price * l.qty, 0);
  const code = coupon.get(); const c = code && COUPONS[code]; const discount = c ? c.off(subtotal) ?? 0 : 0;
  const shipping = subtotal === 0 || subtotal - discount >= 40 ? 0 : 5;
  return { subtotal, code: c ? code : null, discount, shipping, total: Math.max(0, subtotal - discount + shipping) };
}
// The cart link only works once the cart has something in it, so "Add to cart" always lands before "Cart" can be opened.
function badge() {
  const n = cart.get().reduce((s, x) => s + x.qty, 0); const b = document.getElementById("cartlink"); if (!b) return;
  b.textContent = `Cart (${n})`; b.classList.toggle("empty", n === 0);
  if (n === 0) { b.setAttribute("aria-disabled", "true"); b.title = "Your cart is empty"; } else { b.removeAttribute("aria-disabled"); b.removeAttribute("title"); }
}
document.addEventListener("click", (e) => { const a = e.target.closest && e.target.closest("#cartlink.empty"); if (a) e.preventDefault(); }, true);
document.addEventListener("DOMContentLoaded", badge);
