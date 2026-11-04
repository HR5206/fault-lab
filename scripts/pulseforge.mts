import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { loadScenarios } from "../src/scenarios.mts";
import { startLab } from "../src/server.mts";

const lab = await startLab(loadScenarios(), "flaky-health", "127.0.0.1", 0);
async function probe(deadline: number): Promise<number | "TIMEOUT"> {
  try {
    const response = await fetch(lab.url + "/health", { signal: AbortSignal.timeout(deadline) });
    await response.text();
    return response.status;
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return "TIMEOUT";
    throw error;
  }
}
try {
  console.log("PulseForge-style local monitor | fresh temporary lab | no AWS");
  let previous = "UNKNOWN";
  const events: string[] = [];
  for (let n = 1; n <= 4; n++) {
    const status = await probe(5000);
    const state = typeof status === "number" && status >= 200 && status < 300 ? "UP" : "DOWN";
    const event = state === "DOWN" && previous !== "DOWN" ? "incident opened" :
      state === "UP" && previous === "DOWN" ? "recovered" : "unchanged";
    console.log(n + " | " + status + " | " + state + " | " + event);
    events.push(event); previous = state;
  }
  assert.deepEqual(events, ["incident opened", "unchanged", "recovered", "unchanged"]);

  const reset = await fetch(lab.url + "/_lab/reset", { method:"POST", headers:{ "content-type":"application/json" }, body:"{}" });
  assert.equal(reset.status, 200); await reset.text();
  console.log("\nSame scenario | GET retries | 300 ms deadline per attempt");
  const attempts: (number | string)[] = [];
  for (let n = 1; n <= 4; n++) {
    const status = await probe(300); attempts.push(status);
    console.log("attempt " + n + ": " + status);
    // This is a GET probe. A timeout on a write wouldn't prove the write failed.
    if ((status !== 503 && status !== "TIMEOUT") || n === 4) break;
    await pause(40 * 2 ** (n - 1));
  }
  assert.deepEqual(attempts, [503, 503, "TIMEOUT", 200]);
  console.log("Verified: one incident, one recovery, and a retry after a client timeout.");
} finally { await lab.close(); }
