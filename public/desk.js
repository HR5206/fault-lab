const el = id => document.getElementById(id);
const text = (id, value) => { el(id).textContent = value; };
function options(select, choices) {
  if (JSON.stringify(choices) === select.dataset.choices) return;
  const old = select.value;
  select.replaceChildren(...choices.map(s => new Option(s, s)));
  if (choices.includes(old)) select.value = old;
  select.dataset.choices = JSON.stringify(choices);
}
let lastRun;
async function refresh() {
  const response = await fetch("/_lab/state", { cache: "no-store" });
  if (!response.ok) throw new Error("HTTP " + response.status);
  const state = await response.json();
  text("connection", "● Connected");
  text("active", state.scenario); text("description", state.description);
  text("run", "Run " + state.run + " · pending: " + state.pending);
  options(el("scenario"), state.names);
  if (lastRun !== state.run) { el("scenario").value = state.scenario; lastRun = state.run; }
  options(el("route"), state.routes.map(r => r.method + " " + r.path));
  el("token").hidden = el("token-label").hidden = !state.needsToken;
  el("sequence").replaceChildren(...state.routes.map(r => {
    const p = document.createElement("p"); p.className = "route-plan";
    const title = document.createElement("strong"); title.textContent = r.method + " " + r.path;
    p.append(title, r.steps.map(s => s.status + (s.delayMs ? " (" + s.delayMs + " ms)" : "")).join(" → ") + " · hold last");
    return p;
  }));
  const body = el("rows"); body.replaceChildren();
  if (!state.log.length) {
    const c = body.insertRow().insertCell(); c.colSpan = 7; c.textContent = "No requests yet. Choose an endpoint and send it once.";
  }
  for (const r of state.log) {
    const row = body.insertRow();
    for (const value of [r.id, r.run, r.method + " " + r.path, r.hit + " / " + r.step,
      r.planned, r.state, r.ms === null ? "…" : r.ms + " ms"]) row.insertCell().textContent = String(value);
    row.cells[4].className = r.planned >= 400 ? "bad" : "good";
  }
}
async function poll() {
  try { await refresh(); } catch { text("connection", "Disconnected"); }
  setTimeout(poll, 900);
}
el("reset").addEventListener("click", async () => {
  try {
    const key = el("token").value;
    const r = await fetch("/_lab/reset", { method:"POST", headers:{ "content-type":"application/json",
      ...(key ? { authorization:"Bearer " + key } : {}) }, body:JSON.stringify({ scenario:el("scenario").value }) });
    const data = await r.json(); if (!r.ok) throw new Error(data.error || "Reset failed.");
    text("message", "Started run " + data.run + ". The next hit is 1."); await refresh();
  } catch (error) { text("message", error.message); }
});
el("probe").addEventListener("click", async () => {
  try {
    const [method, path] = el("route").value.split(" ");
    if (!path) return;
    const r = await fetch(path, { method, cache:"no-store" });
    const result = await r.text();
    text("message", method + " " + path + " → " + r.status + " " + result.slice(0,100)); await refresh();
  } catch (error) { text("message", error.message); }
});
poll();
