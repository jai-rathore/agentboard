// Mock store: nothing leaves the page.
const $ = (id) => document.getElementById(id);
let product = null;
document.querySelectorAll(".card").forEach((c) => c.addEventListener("click", () => {
  document.querySelectorAll(".card").forEach((x) => x.classList.remove("sel"));
  c.classList.add("sel"); product = c;
}));
$("buy").addEventListener("click", () => {
  const q = Math.max(1, Math.min(9, Number($("qty").value) || 1)), name = $("name").value.trim(), addr = $("addr").value.trim();
  if (!product) { $("err").textContent = "Choose a coffee first."; return; }
  if (!name || !addr) { $("err").textContent = "Name and address are required."; return; }
  $("err").textContent = "";
  $("done").style.display = "block";
  $("done").textContent = `Order confirmed: ${q} x ${product.dataset.p} ($${q * Number(product.dataset.c)}) shipping to ${name}, ${addr}.`;
});
