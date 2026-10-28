// Page script (external: the site CSP is script-src 'self', so inline scripts never run).
const grid = document.getElementById("grid");
function render() {
  const q = document.getElementById("q").value.trim().toLowerCase(), max = Number(document.getElementById("max").value) || Infinity;
  const hits = CATALOG.filter((p) => (!q || `${p.name} ${p.cat}`.toLowerCase().includes(q)) && p.price <= max).sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
  document.getElementById("count").textContent = `${hits.length} result${hits.length === 1 ? "" : "s"}${q || max !== Infinity ? " · sorted by price" : ""}`;
  grid.innerHTML = hits.length ? "" : '<p style="font-family:Arial,sans-serif">No products match. Try a higher max price.</p>';
  for (const p of hits) {
    const d = document.createElement("div"); d.className = "card";
    d.innerHTML = `<b>${p.name}</b><span class="cat">${p.cat}</span><span class="price">${money(p.price)}</span><button type="button">Add to cart</button>`;
    d.querySelector("button").addEventListener("click", (e) => { addToCart(p.id); e.currentTarget.textContent = "✓ Added"; document.getElementById("msg").textContent = `Added ${p.name} (${money(p.price)}) to your cart.`; });
    grid.appendChild(d);
  }
}
document.getElementById("go").addEventListener("click", render);
document.getElementById("q").addEventListener("keydown", (e) => { if (e.key === "Enter") render(); });
render();
