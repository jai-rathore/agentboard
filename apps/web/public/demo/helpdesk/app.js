// Mock helpdesk: everything stays in this page (no network). Ticket numbers are stable per email+subject.
const $ = (id) => document.getElementById(id);
$("submit").addEventListener("click", () => {
  const email = $("email").value.trim(), subject = $("subject").value.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { $("err").textContent = "Enter a valid customer email."; return; }
  if (!subject) { $("err").textContent = "Subject is required."; return; }
  $("err").textContent = "";
  let h = 0; for (const c of email + subject) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  $("ok").style.display = "block";
  $("ok").textContent = `Ticket #${1000 + (h % 9000)} created for ${email} (${$("prio").value}): ${subject}`;
});
