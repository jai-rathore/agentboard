// Page script (external: the site CSP is script-src 'self', so inline scripts never run).
const t = totals(); document.getElementById("summary").textContent = `${lines().map((l) => `${l.qty} × ${l.name}`).join(", ") || "Your cart is empty"} · total ${money(t.total)}`;
document.getElementById("f").addEventListener("submit", (e) => e.preventDefault());
document.getElementById("place").addEventListener("click", () => {
  const name = document.getElementById("name").value.trim(), addr = document.getElementById("addr").value.trim();
  if (!lines().length) { document.getElementById("err").textContent = "Your cart is empty."; return; }
  if (!name || !addr) { document.getElementById("err").textContent = "Name and address are required."; return; }
  document.getElementById("err").textContent = "";
  document.getElementById("done").textContent = `Order confirmed (mock): ${money(totals().total)} shipping to ${name}, ${addr}.`;
  cart.set([]); coupon.set(null); badge();
});
