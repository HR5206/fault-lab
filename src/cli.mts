import { parseArgs } from "node:util";
import { loadScenarios } from "./scenarios.mts";
import { startLab } from "./server.mts";

const help = [
  "Fault Lab | repeatable HTTP failures", "",
  "npm start                                      Start the default lab",
  "npm run lab -- serve --scenario flaky-health    Choose a named scenario",
  "npm run lab -- list                            List JSON scenarios",
  "npm run lab -- hit /health                     Send one request",
  "npm run lab -- reset [scenario]                Reset or select a scenario",
  "npm run lab -- logs                            Print recent request results", "",
  "Serve/list: --dir <scenario-folder>. Serve: --host <address> --port <number>.",
  "Client commands: --url <server-url>. Hit: --method GET --timeout <milliseconds>."
].join("\n");

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: "boolean", short: "h" }, scenario: { type: "string" }, dir: { type: "string" },
    host: { type: "string" }, port: { type: "string" }, url: { type: "string" },
    method: { type: "string" }, timeout: { type: "string" }
  } });
  const [command, arg, ...rest] = positionals;
  if (!command || command === "help" || values.help) return console.log(help);
  if (rest.length) throw new Error("Too many arguments.");
  if (command === "list" || command === "serve") {
    if (arg) throw new Error("Use --scenario to select a scenario.");
    const cases = loadScenarios(values.dir ?? process.env.SCENARIO_DIR);
    if (command === "list") { for (const s of cases) console.log(s.name + " — " + s.description); return; }
    const host = values.host ?? process.env.HOST ?? "127.0.0.1";
    const port = Number(values.port ?? process.env.PORT ?? 4310);
    const name = values.scenario ?? process.env.SCENARIO ?? "flaky-health";
    const lab = await startLab(cases, name, host, port, process.env.FAULT_LAB_TOKEN ?? "");
    console.log("Fault Lab: " + lab.url + " | " + name + " | Ctrl+C to stop");
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void lab.close(); });
    return;
  }
  const base = values.url ?? process.env.FAULT_LAB_URL ?? "http://127.0.0.1:4310";
  if (command === "reset") {
    const token = process.env.FAULT_LAB_TOKEN;
    const res = await fetch(new URL("/_lab/reset", base), { method: "POST", signal: AbortSignal.timeout(5000),
      headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
      body: JSON.stringify(arg ? { scenario: arg } : {}) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? "Reset failed.");
    console.log("Run " + body.run + ": " + body.scenario + " starts at hit 1.");
  } else if (command === "hit") {
    const path = arg ?? "/health";
    if (!/^\/(?!\/)/.test(path) || path.includes("\\")) throw new Error("Supply a path such as /health.");
    const timeout = Number(values.timeout ?? 5000);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error("Timeout must be 1–60000 ms.");
    const start = performance.now();
    const res = await fetch(new URL(path, base), { method: values.method ?? "GET", signal: AbortSignal.timeout(timeout) });
    const text = await res.text();
    console.log("HTTP " + res.status + " | run " + res.headers.get("x-fault-lab-run") + " | hit " +
      res.headers.get("x-fault-lab-hit") + " | " + Math.round(performance.now() - start) + " ms\n" + text);
  } else if (command === "logs") {
    if (arg) throw new Error("logs takes no positional arguments.");
    const res = await fetch(new URL("/_lab/state", base), { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error("Cannot read log: HTTP " + res.status);
    const state = await res.json();
    console.table(state.log.map((r: Record<string, unknown>) => ({ id:r.id,run:r.run,path:r.path,hit:r.hit,step:r.step,plan:r.planned,outcome:r.state,ms:r.ms })));
  } else throw new Error("Unknown command.\n" + help);
}
main().catch(e => { console.error("fault-lab:", e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
