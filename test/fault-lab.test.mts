import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { loadScenarios, parseScenario, type Scenario } from "../src/scenarios.mts";
import { startLab } from "../src/server.mts";

async function fixture(t: TestContext, cases = loadScenarios(), token = "") {
  const lab = await startLab(cases, cases[0].name, "127.0.0.1", 0, token);
  t.after(lab.close);
  const get = (path: string, options?: RequestInit) => fetch(lab.url + path, options);
  const state = async () => (await get("/_lab/state")).json();
  const reset = (data: unknown = {}, key = token) => get("/_lab/reset", { method:"POST",
    headers:{ "content-type":"application/json", ...(key ? { authorization:"Bearer " + key } : {}) }, body:JSON.stringify(data) });
  async function hit(path = "/health", options?: RequestInit) {
    const r = await get(path, options);
    return { status:r.status, body:await r.text(), run:r.headers.get("x-fault-lab-run"),
      hit:r.headers.get("x-fault-lab-hit"), step:r.headers.get("x-fault-lab-step") };
  }
  return { get, hit, state, reset };
}

async function until(condition: () => Promise<boolean>) {
  const end = Date.now() + 2500;
  do { if (await condition()) return; await pause(5); } while (Date.now() < end);
  assert.fail("Timed out waiting for the server to record the event");
}
function one(name: string, delayMs: number): Scenario {
  return parseScenario({ name, description:name, routes:[
    { method:"GET", path:"/health", steps:[{status:200, delayMs, body:{name}}, {status:200,body:"next"}] }
  ] });
}

test("the shipped health sequence is 503, 503, delayed 200, then immediate 200s", async t => {
  const f = await fixture(t);
  assert.equal((await f.hit()).status, 503);
  assert.equal((await f.hit()).status, 503);
  const began = performance.now();
  let slowFinished = false;
  const third = f.hit().then(r => { slowFinished = true; return r; });
  await until(async () => (await f.state()).pending === 1);
  const fourth = await f.hit();
  assert.equal(fourth.status, 200); assert.equal(fourth.hit, "4"); assert.equal(fourth.step, "4");
  assert.equal(slowFinished, false, "the slow request shouldn't block the immediate one");
  const slow = await third;
  assert.equal(slow.status, 200); assert.equal(slow.hit, "3"); assert.equal(slow.step, "3");
  assert.ok(performance.now() - began >= 1900, "the third response has a two-second timer");
  assert.equal((await f.hit()).step, "4");
  const { log } = await f.state();
  assert.equal(log.length, 5); assert.equal(log[0].delayMs, 0);
  assert.ok(log.find((r: { hit: number }) => r.hit === 3).ms >= 1900);
});

test("endpoint counters are independent; reset reproduces the first hit and keeps run history", async t => {
  const f = await fixture(t);
  assert.equal((await f.hit("/version")).hit, "1");
  assert.equal((await f.hit("/health?source=test")).hit, "1");
  assert.equal((await f.hit("/version")).hit, "2");
  const reset = await f.reset(); assert.equal(reset.status, 200); assert.equal((await reset.json()).run, 2);
  const replay = await f.hit(); assert.deepEqual([replay.status,replay.hit,replay.step,replay.run], [503,"1","1","2"]);
  assert.equal((await f.state()).log.filter((r: { run: number }) => r.run === 1).length, 3);
});

test("a pending response keeps its original run and body when a new scenario starts", async t => {
  const f = await fixture(t, [one("old", 350), one("new", 0)]);
  const earlier = f.hit();
  await until(async () => (await f.state()).pending === 1);
  await (await f.reset({ scenario:"new" })).text();
  const fresh = await f.hit(); const old = await earlier;
  assert.deepEqual([old.run,old.hit,JSON.parse(old.body).name], ["1","1","old"]);
  assert.deepEqual([fresh.run,fresh.hit,JSON.parse(fresh.body).name], ["2","1","new"]);
});

test("disconnect cancels the delayed send, records elapsed time, and does not refund a hit", async t => {
  const f = await fixture(t, [one("timeout-test", 1200)]);
  const controller = new AbortController();
  const request = f.hit("/health", { signal:controller.signal });
  await until(async () => (await f.state()).pending === 1);
  controller.abort();
  await assert.rejects(request);
  await until(async () => (await f.state()).log[0].state === "disconnected");
  const row = (await f.state()).log[0];
  assert.equal(row.planned, 200); assert.ok(row.ms >= 0); assert.ok(row.ms < 1200);
  assert.equal((await f.hit()).hit, "2");
});

test("overlapping requests get distinct consecutive hit numbers and hold the final step", async t => {
  const f = await fixture(t, [one("overlap", 40)]);
  const results = await Promise.all(Array.from({length:12}, () => f.hit()));
  const hits = results.map(r => Number(r.hit)).sort((a,b) => a-b);
  assert.deepEqual(hits, Array.from({length:12}, (_,i) => i+1));
  assert.equal(results.filter(r => r.step === "1").length, 1);
  assert.equal(results.filter(r => r.step === "2").length, 11);
});

test("readiness, the page, and an unknown method do not advance a scenario", async t => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.get("/_lab/ready")).json(), {ready:true});
  assert.match(await (await f.get("/")).text(), /Request log/);
  assert.equal((await f.hit("/health", { method:"POST" })).status, 404);
  assert.equal((await f.hit("/missing")).status, 404);
  assert.equal((await f.state()).log.length, 0);
  assert.equal((await f.hit()).hit, "1");
});

test("a second named recipe serves configurable POST responses and JSON bodies", async t => {
  const f = await fixture(t);
  await (await f.reset({scenario:"slow-after-recovery"})).text();
  const first = await f.hit("/jobs", { method:"POST" }); const next = await f.hit("/jobs", { method:"POST" });
  assert.equal(first.status, 503); assert.deepEqual(JSON.parse(first.body), {accepted:false});
  assert.equal(next.status, 202); assert.equal(JSON.parse(next.body).accepted, true);
});

test("reset rejects invalid input or credentials without changing the active run", async t => {
  const key = "a-test-key-long-enough";
  const f = await fixture(t, loadScenarios(), key);
  await f.hit();
  assert.equal((await f.reset({}, "")).status, 401);
  assert.equal((await f.reset({}, "wrong")).status, 401);
  assert.equal((await f.reset({scenario:"missing"})).status, 404);
  assert.equal((await f.reset({other:1})).status, 400);
  assert.equal((await f.get("/_lab/reset", {method:"POST",headers:{authorization:"Bearer " + key}})).status, 415);
  assert.equal((await f.state()).run, 1);
  assert.equal((await f.reset()).status, 200);
});

test("public binding requires a token; a foreign Origin cannot reset a local run", async t => {
  await assert.rejects(startLab(loadScenarios(), "flaky-health", "0.0.0.0", 0), /FAULT_LAB_TOKEN/);
  const f = await fixture(t);
  const result = await f.get("/_lab/reset", {method:"POST",headers:{"content-type":"application/json",origin:"https://unrelated.invalid"},body:"{}"});
  assert.equal(result.status, 403); assert.equal((await f.state()).run, 1);
});

test("invalid recipes identify the bad field before the server starts", () => {
  const base = {name:"bad",description:"test",routes:[{method:"GET",path:"/health",steps:[{status:200,body:{}}]}]};
  for (const [step, message] of [
    [{status:100,body:{}}, /status/], [{status:200,delayMs:-1,body:{}}, /delayMs/],
    [{status:204,body:{}}, /null/], [{status:200}, /JSON body/],
    [{status:200,delay:500,body:{}}, /unknown field/]
  ] as const) assert.throws(() => parseScenario({...base,routes:[{...base.routes[0],steps:[step]}]}), message);
  assert.throws(() => parseScenario({...base,routes:[base.routes[0],base.routes[0]]}), /Duplicate/);
  assert.throws(() => parseScenario({...base,routes:[{...base.routes[0],path:"/_lab/state"}]}), /literal route/);
  assert.throws(() => parseScenario({...base,routes:[{...base.routes[0],steps:[]}]}), /steps/);
});

test("the log drops older entries after 200 accepted fixture requests", async t => {
  const f = await fixture(t, [one("bounded-log", 0)]);
  for (let i = 0; i < 21; i++) await Promise.all(Array.from({length:10}, () => f.hit()));
  const s = await f.state();
  assert.equal(s.log.length, 200); assert.equal(s.log[0].id, 210); assert.equal(s.log.at(-1).id, 11);
  assert.equal(s.routes[0].hits, 210); assert.equal(s.pending, 0);
});
