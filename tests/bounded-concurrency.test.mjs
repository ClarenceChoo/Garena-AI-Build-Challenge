import assert from "node:assert/strict";
import test from "node:test";
import { createConcurrencyGate } from "../lib/bounded-concurrency.js";

test("concurrency gate never exceeds its permit count", async () => {
  const gate = createConcurrencyGate(2);
  let active = 0;
  let peak = 0;
  let unblock;
  const blocked = new Promise((resolve) => {
    unblock = resolve;
  });

  const work = Array.from({ length: 6 }, (_, index) => gate.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    if (index < 2) await blocked;
    active -= 1;
    return index;
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.activeCount, 2);
  assert.equal(gate.pendingCount, 4);
  unblock();

  assert.deepEqual(await Promise.all(work), [0, 1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
  assert.equal(gate.activeCount, 0);
  assert.equal(gate.pendingCount, 0);
});

test("a canceled waiter never starts and does not consume a permit", async () => {
  const gate = createConcurrencyGate(1);
  let unblock;
  const blocked = new Promise((resolve) => {
    unblock = resolve;
  });
  const running = gate.run(() => blocked);
  const controller = new AbortController();
  let started = false;
  const waiting = gate.run(() => {
    started = true;
  }, controller.signal);

  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(started, false);
  assert.equal(gate.pendingCount, 0);

  unblock();
  await running;
  assert.equal(gate.activeCount, 0);
});

test("a throwing task returns its permit", async () => {
  const gate = createConcurrencyGate(1);
  await assert.rejects(gate.run(() => {
    throw new Error("expected failure");
  }), /expected failure/);
  assert.equal(await gate.run(() => "next task"), "next task");
});
