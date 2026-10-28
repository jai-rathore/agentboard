// Mock ticket lookup: deterministic per ticket number + email, no network.
const $ = (id) => document.getElementById(id);
const STATUS = ["Open", "In progress", "Waiting on customer", "Resolved"];
const AGENTS = ["Priya N. (Tier 2)", "Marcus L. (Tier 1)", "Dana K. (Network team)", "Wei Z. (Tier 2)", "Sam O. (Billing)"];
const PRIO = ["Low", "Normal", "High", "Urgent"];
const NEXT = { "Open": "Waiting for an agent to pick it up", "In progress": "An agent is working on it", "Waiting on customer": "Reply to the agent's last email", "Resolved": "Nothing: reopen within 7 days if needed" };
$("look").addEventListener("click", () => {
  const n = $("num").value.trim().replace(/^#/, ""), email = $("email").value.trim().toLowerCase();
  $("card").style.display = "none";
  if (!/^\d{4}$/.test(n) || Number(n) < 1000) { $("err").textContent = "Ticket numbers have 4 digits, e.g. 5379."; return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { $("err").textContent = "Enter the email the ticket was filed under."; return; }
  $("err").textContent = "";
  let h = Number(n); for (const c of email) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const st = STATUS[h % 4];
  $("title").textContent = `Ticket #${n} · ${email}`;
  $("st").innerHTML = `<span class="pill ${st.split(" ")[0]}">${st}</span>`;
  $("who").textContent = AGENTS[(h >>> 3) % AGENTS.length];
  $("prio").textContent = PRIO[(h >>> 5) % 4];
  $("upd").textContent = `${1 + ((h >>> 7) % 23)} hours ago`;
  $("next").textContent = NEXT[st];
  $("card").style.display = "block";
});
