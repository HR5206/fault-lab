# Optional shared demo

Local use is sufficient to reproduce all tests. If you want a public demo, use a Node web service (not static hosting), with a single process/instance:

- Runtime: Node 24.12 or newer.
- Install: `npm ci --omit=dev`.
- Start: `npm start`.
- Environment: `HOST=0.0.0.0`; use the platform's `PORT`; set a private `FAULT_LAB_TOKEN` of at least 16 random characters.
- Health-check path: `/_lab/ready`. `/health` intentionally fails and must not be the host's readiness probe.
- Termination: the CLI handles SIGTERM/SIGINT and closes the HTTP server.

Use TLS at the host/proxy. Do not expose the reset token in browser code, screenshots, or the README. Reset through your local CLI with the token in your shell environment and `--url` set to the actual deployed address. The public request log does not need the token.

Verify readiness first, then reset and check `/health`: 503, 503, a delayed 200, and a fast 200. Verify unauthenticated reset returns 401. Save the actual tested URL in GitHub About. No deployment is created by this audit.

Visitors share counters and can consume one another's steps. State is in RAM; a restart clears it. Scaling to multiple instances breaks the single-sequence expectation. Keep host usage limits enabled; no paid hosting is required to demonstrate the project locally.
