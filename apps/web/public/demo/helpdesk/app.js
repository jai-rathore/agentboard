// Mock helpdesk: everything stays in this page (no network). Ticket numbers are stable per email+subject.
// ?v=2 switches to a "redesign" (renamed labels, reordered fields, submit button moved to the top and
// renamed) to demonstrate Agentboard Skills self-healing. The ticket logic and banner are unchanged.
const $ = (id) => document.getElementById(id);
const v2 = new URLSearchParams(location.search).get("v") === "2";
$(v2 ? "v2" : "v1").className = "on";
if (v2) {
  document.body.classList.add("v2");
  document.title = "Acme Service Desk (Agentboard Skills demo)";
  document.querySelector("header").firstChild.textContent = "Acme Service Desk";
  const relabel = (id, text, placeholder) => { const l = $(id).closest("label"); l.firstChild.textContent = text; if (placeholder !== undefined) $(id).placeholder = placeholder; };
  relabel("email", "Requester e-mail", "you@company.com");
  relabel("subject", "Summary", "What is wrong?");
  relabel("prio", "Urgency");
  relabel("desc", "Details");
  const main = document.querySelector("main"), h2 = main.querySelector("h2");
  h2.textContent = "Open a request";
  const bar = document.createElement("div"); bar.className = "bar";
  main.insertBefore(bar, h2); bar.appendChild(h2);
  $("submit").textContent = "Submit request"; bar.appendChild($("submit"));
  main.insertBefore($("prio").closest("label"), $("subject").closest("label"));
}
$("submit").addEventListener("click", () => {
  const email = $("email").value.trim(), subject = $("subject").value.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { $("err").textContent = v2 ? "Enter a valid requester e-mail." : "Enter a valid customer email."; return; }
  if (!subject) { $("err").textContent = v2 ? "Summary is required." : "Subject is required."; return; }
  $("err").textContent = "";
  let h = 0; for (const c of email + subject) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  $("ok").style.display = "block";
  $("ok").textContent = `Ticket #${1000 + (h % 9000)} created for ${email} (${$("prio").value}): ${subject}`;
});
