import express from "express";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Scenario } from "./scenarios.mts";

const assets = fileURLToPath(new URL("../public/", import.meta.url));
const loopback = (host: string) => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
type Entry = {
  id: number; run: number; scenario: string; method: string; path: string;
  hit: number | null; step: number | null; planned: number; delayMs: number;
  state: "pending" | "sent" | "disconnected"; ms: number | null; at: string;
};

function sameKey(actual: string, expected: string) {
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createLab(scenarios: Scenario[], first: string, token = "") {
  const selected = scenarios.find(s => s.name === first);
  if (!selected) throw new Error("Unknown scenario: " + first);
  let current: Scenario = selected;
  let run = 1, nextId = 1, pending = 0;
  const counts = new Map<string, number>();
  const rows: Entry[] = [];
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  app.enable("case sensitive routing");
  app.enable("strict routing");
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Content-Security-Policy", "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (!token && !loopback(req.hostname)) return res.status(403).json({ error: "Use a loopback host for local mode." });
    next();
  });

  app.get("/", (_req, res) => res.sendFile(join(assets, "index.html")));
  app.use("/_lab/assets", express.static(assets, { index: false, redirect: false }));
  // A hosting health check must not consume a step or restart a simulated outage.
  app.get("/_lab/ready", (_req, res) => res.json({ ready: true }));
  app.get("/_lab/state", (_req, res) => res.json({
    scenario: current.name, description: current.description, run, pending,
    needsToken: Boolean(token), names: scenarios.map(s => s.name),
    routes: current.routes.map(r => ({ method: r.method, path: r.path,
      hits: counts.get(r.method + " " + r.path) ?? 0,
      steps: r.steps.map(step => ({ status: step.status, delayMs: step.delayMs })) })),
    log: [...rows].reverse()
  }));
  app.post("/_lab/reset", (req, res, next) => {
    const origin = req.get("origin"), host = req.get("host");
    if (origin && origin !== "http://" + host && origin !== "https://" + host) return res.status(403).json({ error: "Cross-origin reset denied." });
    if (token && !sameKey(req.get("authorization") ?? "", "Bearer " + token)) return res.status(401).json({ error: "Reset requires the admin token." });
    if (!req.is("application/json")) return res.status(415).json({ error: "Send a JSON object; {} resets the current scenario." });
    next();
  }, express.json({ limit: "1kb" }), (req, res) => {
    const data = req.body;
    if (!data || Array.isArray(data) || typeof data !== "object" || Object.keys(data).some(k => k !== "scenario") ||
        (Object.hasOwn(data, "scenario") && typeof data.scenario !== "string")) return res.status(400).json({ error: "Expected {} or {\"scenario\":\"name\"}." });
    const chosen = scenarios.find(s => s.name === (data.scenario ?? current.name));
    if (!chosen) return res.status(404).json({ error: "Unknown scenario." });
    current = chosen; counts.clear(); run++;
    res.json({ scenario: current.name, run });
  });
  app.use("/_lab", (_req, res) => res.status(404).json({ error: "No such control route." }));

  app.use((req, res) => {
    const route = current.routes.find(r => r.method === req.method && r.path === req.path);
    if (!route) return res.status(404).json({ error: "No configured route for this method and path." });
    if (pending >= 64) return res.status(429).json({ error: "64 fixture requests are already pending. No step consumed." });

    // Reserve the position now. A delayed third request must not block the fourth.
    const key = route.method + " " + route.path;
    const hit = (counts.get(key) ?? 0) + 1;
    counts.set(key, hit);
    const step = Math.min(hit, route.steps.length);
    const plan = route.steps[step - 1];
    const row: Entry = { id: nextId++, run, scenario: current.name, method: route.method,
      path: route.path, hit, step, planned: plan.status, delayMs: plan.delayMs,
      state: "pending", ms: null, at: new Date().toISOString() };
    rows.push(row);
    if (rows.length > 200) rows.shift();
    const start = performance.now();
    let timer: NodeJS.Timeout | undefined;
    pending++;
    function finish(state: "sent" | "disconnected") {
      if (row.state !== "pending") return;
      if (timer) clearTimeout(timer);
      row.state = state; row.ms = Math.round((performance.now() - start) * 10) / 10; pending--;
    }
    res.once("finish", () => finish("sent"));
    res.once("close", () => finish("disconnected"));
    res.set({ "X-Fault-Lab-Run": String(row.run), "X-Fault-Lab-Hit": String(hit),
      "X-Fault-Lab-Step": String(step), "X-Fault-Lab-Request": String(row.id) });
    function send() {
      if (res.destroyed || row.state !== "pending") return;
      res.status(plan.status);
      if ([204,205,304].includes(plan.status)) res.end(); else res.json(plan.body);
    }
    if (plan.delayMs) timer = setTimeout(send, plan.delayMs); else send();
  });

  const onError: express.ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status === 413 ? 413 : err.status === 400 ? 400 : 500;
    res.status(status).json({ error: status === 413 ? "Request body too large." : status === 400 ? "Invalid JSON." : "Internal server error." });
  };
  app.use(onError);
  return app;
}

export async function startLab(scenarios: Scenario[], name: string, host = "127.0.0.1", port = 4310, token = "") {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port.");
  if ((!loopback(host) || token) && token.length < 16) throw new Error("Set FAULT_LAB_TOKEN to at least 16 characters to enable public hosting.");
  const app = createLab(scenarios, name, token);
  const server = app.listen(port, host);
  await new Promise<void>((yes, no) => { server.once("listening", yes); server.once("error", no); });
  const address = server.address() as AddressInfo;
  const url = "http://" + (host.includes(":") ? "[" + host + "]" : host) + ":" + address.port;
  const close = () => new Promise<void>((yes, no) => { server.close(e => e ? no(e) : yes()); server.closeIdleConnections(); });
  return { url, close, server };
}
