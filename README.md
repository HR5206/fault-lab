# Fault Lab

When I'm testing a retry loop, I want the same failure twice. Fault Lab gives me a small HTTP server whose responses come from a named JSON file. I can run the client, reset the scenario, and try the fix against the same sequence.

The question behind the default example is simple: **what happens if request three is slow but request four is healthy?**

## Run it

Use a recent **Node 24 LTS (24.12 or newer)** and npm. I use Node's native TypeScript execution; there is no build step for the server. The lockfile pins the Express dependencies.

Clone `https://github.com/HR5206/fault-lab.git` and open the `fault-lab` folder (the one containing `package.json`) in VS Code. In **Terminal → New Terminal**, run:

~~~sh
npm ci
npm start
~~~

Open **http://127.0.0.1:4310/** for the request log. Pick **GET /health** and click **Send once** four times. Leave that terminal running. To drive it from a *second* terminal in the same folder:

~~~sh
npm run lab -- hit /health
npm run lab -- logs
npm run lab -- reset
~~~

The CLI and the page talk to the **same counters**. Reset before a new experiment if you've already clicked the button. Stop the server with Ctrl+C. Running locally needs no paid services or API keys.

## What should happen?

| Hit on `GET /health` | Status | Configured delay | Meaning |
|---|---:|---:|---|
| 1 | 503 | 0 ms | Warming up |
| 2 | 503 | 0 ms | Still unavailable |
| 3 | 200 | 2,000 ms | Slow recovery |
| 4 and later | 200 | 0 ms | Healthy; keep using the last step |

A zero delay means **no artificial wait**, not a promise of zero network latency. Inspect `X-Fault-Lab-Run`, `X-Fault-Lab-Hit` and `X-Fault-Lab-Step` on a fixture response to see exactly what ran.

**Concurrency rule:** I reserve the next hit number in the Express handler, before starting a timer. Each method/path pair has its own counter. A fourth accepted request can finish while the third is still waiting. Arrival at the server determines the assignment; the order in which a client launched its requests is not a guarantee.

**Reset rule:** A reset starts a new run and clears the counters. A pending request keeps its old run, selected response and timer. Rows from the previous run remain visible until they age out of the log.

**Disconnect rule:** If a client closes the connection while a delay is pending, Fault Lab clears its timer and marks the row `disconnected`. The hit remains consumed. `Planned` is the intended status; a disconnected client might have received no HTTP status. `Sent` means the server finished writing, not proof that a remote application processed the response.

## Reproduce a bug by name

~~~sh
npm run lab -- list
npm run lab -- reset slow-after-recovery
npm run lab -- hit /jobs --method POST
npm run lab -- reset flaky-health
~~~

The second recipe fails twice, recovers, then keeps adding a delay. Its `POST /jobs` route returns mock JSON; it performs no real write.

To add a recipe, create a `.json` file under `scenarios/`:

~~~json
{
  "name": "one-bad-read",
  "description": "One failure before a successful read.",
  "routes": [{
    "method": "GET",
    "path": "/report",
    "steps": [
      { "status": 503, "body": { "available": false } },
      { "status": 200, "delayMs": 150, "body": { "available": true } }
    ]
  }]
}
~~~

Use a unique lowercase name. Methods are GET, POST, PUT, PATCH or DELETE. Routes use literal paths, not patterns or query-string matching. The dashboard and `/_lab` namespace are reserved. Give every step a JSON `body` and an integer HTTP status from 200–599. Delays are in milliseconds, default to zero and have a 30-second cap; `204`, `205` and `304` need a null body. The last step repeats. Restart the server to pick up edited files, then select your scenario.

~~~sh
npm run lab -- serve --scenario one-bad-read --port 4400
~~~

Replace the port in the browser address as well. Client commands can use `--url http://127.0.0.1:4400`. For the shipped example, run `npm run lab -- hit /health --timeout 300` to give a probe a 300 ms deadline. A simulated 503 is a valid result from `hit`; a connection error or client timeout exits with an error.

## Demo: a local PulseForge-style monitor

~~~sh
npm run demo
~~~

This starts a separate temporary server on an available local port. It never connects to an AWS account, DynamoDB, or a running PulseForge deployment. First, the monitor records four checks using a deadline long enough to observe the slow recovery:

~~~text
1 | 503 | DOWN | incident opened
2 | 503 | DOWN | unchanged
3 | 200 | UP   | recovered
4 | 200 | UP   | unchanged
~~~

Then it resets the same recipe and tries a bounded GET retry loop with a **300 ms deadline** and a short increasing wait between attempts:

~~~text
503 → 503 → TIMEOUT → 200
~~~

The script asserts both sequences before reporting success. This GET is a read-only probe. A timeout on an operation that changes data does not tell a client whether the operation was applied. Such retries need an idempotent design or an idempotency key, not just a retry loop.

To try your own *local* monitoring code, point its health-check URL at `http://127.0.0.1:4310/health` and reset the lab. A cloud Lambda's localhost is not your laptop.

## Inspect and test

~~~sh
npm run check
npm test
~~~

The suite contains 11 automated tests, including real HTTP requests that overlap, a reset during a pending request, a disconnected client, independent counters, and a bounded log. The two-second example uses an actual timer. The type check runs separately because Node executes this TypeScript without type-checking it.

| Path | Purpose |
|---|---|
| `scenarios/*.json` | Two recipes ready to run or edit |
| `src/scenarios.mts` | Parse and validate recipe files at startup |
| `src/server.mts` | Express routes, hit assignment, timers, reset, request journal |
| `src/cli.mts` | Start, list, probe, reset and read logs |
| `public/` | The live request-log page; plain HTML, CSS and JavaScript |
| `scripts/pulseforge.mts` | The local monitor and retry demonstration |
| `test/fault-lab.test.mts` | HTTP behavior and recipe validation tests |

## Operating limits

One process runs one active scenario. There are no accounts or database. The most recent 200 **accepted fixture requests** are kept in RAM, across runs. A restart clears everything. The page, readiness probes, 404s and requests rejected at the 64-in-flight limit don't advance a fixture. The journal stores configured paths, intended statuses, outcomes, timestamps and elapsed milliseconds; it does not log request bodies, headers or query strings.

`GET /_lab/ready` is the stable hosting health check. `GET /_lab/state` is the read-only journal. `POST /_lab/reset` accepts `{}` or `{"scenario":"name"}` as JSON. Local mode binds to loopback; public binding requires a reset token. A public demo is shared: visitors calling the fixtures advance the same run.


Fault injection with specified delays has useful precedent in [WireMock's fault-simulation documentation](https://wiremock.org/docs/simulating-faults/). Fault Lab is a separate small implementation.

## Sharing a demo

My local demo is the repeatable reference. A small public instance can help someone explore the request log, but every visitor shares the same counters. See [DEPLOYMENT.md](DEPLOYMENT.md) for the process settings and verification steps. I do not treat a hosted flaky endpoint as a stable uptime target.
