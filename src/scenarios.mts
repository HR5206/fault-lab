import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Step = { status: number; delayMs: number; body: unknown };
export type Route = { method: string; path: string; steps: Step[] };
export type Scenario = { name: string; description: string; routes: Route[] };
export const includedScenarios = fileURLToPath(new URL("../scenarios/", import.meta.url));

function fields(value: unknown, allowed: string[], where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(where + ": expected an object");
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(where + ": unknown field " + key);
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(where + ": expected an integer from " + min + " to " + max);
  }
  return value;
}

export function parseScenario(input: unknown): Scenario {
  const s = fields(input, ["name", "description", "routes"], "scenario");
  if (typeof s.name !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(s.name)) throw new Error("Use a lowercase scenario name, such as flaky-health.");
  if (typeof s.description !== "string") throw new Error("Give the scenario a short description.");
  if (!Array.isArray(s.routes) || s.routes.length < 1 || s.routes.length > 32) throw new Error("Define 1–32 routes.");
  const seen = new Set<string>();
  const routes = s.routes.map((raw, i): Route => {
    const at = "routes[" + i + "]";
    const r = fields(raw, ["method", "path", "steps"], at);
    if (typeof r.method !== "string" || !["GET","POST","PUT","PATCH","DELETE"].includes(r.method)) throw new Error(at + ": invalid HTTP method");
    if (typeof r.path !== "string" || !/^\/[a-zA-Z0-9_~-]+(\/[a-zA-Z0-9_~-]+)*$/.test(r.path) ||
        r.path === "/_lab" || r.path.startsWith("/_lab/")) throw new Error(at + ": use a literal route outside /_lab");
    const key = r.method + " " + r.path;
    if (seen.has(key)) throw new Error("Duplicate route: " + key);
    seen.add(key);
    if (!Array.isArray(r.steps) || !r.steps.length || r.steps.length > 64) throw new Error(key + ": define 1–64 steps");
    const steps = r.steps.map((rawStep, j): Step => {
      const label = key + " step " + (j + 1);
      const step = fields(rawStep, ["status", "delayMs", "body"], label);
      const status = integer(step.status, 200, 599, label + " status");
      const delayMs = integer(step.delayMs === undefined ? 0 : step.delayMs, 0, 30_000, label + " delayMs");
      if (!Object.hasOwn(step, "body")) throw new Error(label + ": supply a JSON body (null is allowed)");
      if ([204,205,304].includes(status) && step.body !== null) throw new Error(label + ": this status needs body: null");
      return { status, delayMs, body: step.body };
    });
    return { method: r.method, path: r.path, steps };
  });
  return { name: s.name, description: s.description, routes };
}

export function loadScenarios(dir = includedScenarios): Scenario[] {
  const found: Scenario[] = [];
  for (const name of readdirSync(dir).filter(f => f.endsWith(".json")).sort()) {
    try {
      const file = join(dir, name);
      if (statSync(file).size > 128 * 1024) throw new Error("Scenario exceeds 128 KiB");
      const s = parseScenario(JSON.parse(readFileSync(file, "utf8")));
      if (found.some(other => other.name === s.name)) throw new Error("Duplicate scenario name: " + s.name);
      found.push(s);
    } catch (e) { throw new Error(name + ": " + (e instanceof Error ? e.message : String(e))); }
  }
  if (!found.length) throw new Error("No .json scenarios in " + dir);
  return found;
}
