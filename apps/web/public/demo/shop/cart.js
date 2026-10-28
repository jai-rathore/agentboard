// Page script (external: the site CSP is script-src 'self', so inline scripts never run).
function render() {
  const ls = lines(), t = totals();
  document.getElementById("items").innerHTML = ls.length ? `<table><tr><th>Item</th><th class="r">Price</th><th class="r">Qty</th><th class="r">Line total</th></tr>${ls.map((l) => `<tr><td>${l.name}</td><td class="r">${money(l.price)}</td><td class="r">${l.qty}</td><td class="r">${money(l.price * l.qty)}</td></tr>`).join("")}</table>` : '<p style="font-family:Arial,sans-serif">Your cart is empty.</p>';
  document.getElementById("totals").innerHTML = `Subtotal: ${money(t.subtotal)}<br>${t.code ? `<span class="disc">Coupon ${t.code}: −${money(t.discount)}</span><br>` : ""}Shipping: ${t.shipping ? money(t.shipping) : "free"}<br><b>Total: ${money(t.total)}</b>`;
  document.getElementById("checkout").style.display = ls.length ? "" : "none";
}
document.getElementById("use").addEventListener("click", () => {
  const code = document.getElementById("code").value.trim().toUpperCase(), c = COUPONS[code], err = document.getElementById("err"), msg = document.getElementById("msg");
  err.textContent = ""; msg.textContent = "";
  if (!lines().length) { err.textContent = "Add something to your cart first."; return; }
  if (!c) { err.textContent = `"${code}" is not a valid code.`; return; }
  if (c.off(totals().subtotal) == null) { err.textContent = `${code} needs a subtotal of $30 or more.`; return; }
  coupon.set(code); msg.textContent = `Code ${code} applied: ${c.label}.`; render();
});
render();
