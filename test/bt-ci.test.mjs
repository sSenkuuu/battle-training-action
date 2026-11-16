// Tests for bt-ci.mjs — run with: node --test test/bt-ci.test.mjs
//
// The parsing/threshold tests use a real captured output fixture
// (test/fixtures/local-test-output.txt, from a 5-seed run of the example
// controller). The live tests run the wrapper against the SDK in /tmp
// (copied there by the test setup) with tiny seed counts so they stay fast.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLocalTestOutput, checkThresholds } from "../scripts/bt-ci.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdkDir = "/tmp/bt-action-test-sdk";
const btCi = join(root, "scripts", "bt-ci.mjs");

function ensureSdk() {
  if (existsSync(join(sdkDir, "local-test.mjs"))) return;
  mkdirSync(sdkDir, { recursive: true });
  for (const f of ["arena-sim.mjs", "local-test.mjs"]) {
    const fromCup = join(process.env.HOME, "workspace/goals/battle-training-cup/files", f);
    if (existsSync(fromCup)) cpSync(fromCup, join(sdkDir, f));
  }
  if (!existsSync(join(sdkDir, "local-test.mjs"))) {
    test.skip("official SDK not available locally — live tests need arena-sim.mjs + local-test.mjs");
  }
}

test("parseLocalTestOutput reads a real harness summary", () => {
  const text = readFileSync(join(root, "test/fixtures/local-test-output.txt"), "utf8");
  const r = parseLocalTestOutput(text);
  assert.equal(r.games, 40);
  assert.equal(r.wins + r.losses + r.draws, 40);
  assert.ok(r.winRate > 50 && r.winRate <= 100);
  assert.deepEqual(Object.keys(r.perOpponent).sort(), ["brawler", "holder", "hunter", "random"]);
  assert.equal(r.tickErrors, 0);
  assert.equal(r.rules, "s2.0.0");
});

test("parseLocalTestOutput throws on garbage", () => {
  assert.throws(() => parseLocalTestOutput("nothing to see here"), /summary line/);
});

test("checkThresholds passes the fixture result at arena targets", () => {
  const text = readFileSync(join(root, "test/fixtures/local-test-output.txt"), "utf8");
  const r = parseLocalTestOutput(text);
  const failures = checkThresholds(r, { minWinRate: 50, minBrawler: 60, minHunter: 50, maxRefused: 20 });
  assert.deepEqual(failures, []);
});

test("checkThresholds fails a weak result with specific reasons", () => {
  const weak = {
    games: 40, wins: 10, losses: 30, draws: 0, winRate: 25,
    perOpponent: { brawler: { w: 2, l: 8, d: 0 }, hunter: { w: 3, l: 7, d: 0 } },
    tickErrors: 2, matchesAborted: 1, refusedPerGame: 31,
  };
  const failures = checkThresholds(weak, { minWinRate: 50, minBrawler: 60, minHunter: 50, maxRefused: 20 });
  assert.ok(failures.some((f) => f.includes("overall win rate 25%")));
  assert.ok(failures.some((f) => f.includes("vs brawler")));
  assert.ok(failures.some((f) => f.includes("vs hunter")));
  assert.ok(failures.some((f) => f.includes("tick() error")));
  assert.ok(failures.some((f) => f.includes("refused orders")));
});

test("bt-ci passes the example controller (live, 2 seeds)", () => {
  ensureSdk();
  // Relaxed thresholds here on purpose: with only 2 seeds the per-opponent
  // rate is noisy (brawler can land at 50%). This test checks the wrapper
  // mechanics (run -> parse -> report -> exit 0), not the bot's true rate;
  // the 20-seed numbers live in examples/ssenkuuu-bot/README.md.
  const run = spawnSync(process.execPath, [
    btCi, join(root, "examples/ssenkuuu-bot/controller.js"),
    "--seeds", "2", "--vs", "brawler,hunter",
    "--min-win-rate", "50", "--min-brawler", "50", "--min-hunter", "50",
    "--sdk-dir", sdkDir, "--report", "/tmp/bt-action-test-report.json",
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr + run.stdout.slice(-500));
  const report = JSON.parse(readFileSync("/tmp/bt-action-test-report.json", "utf8"));
  assert.equal(report.passed, true);
  assert.equal(report.games, 8); // 2 seeds x 2 opponents x 2 sides
});

test("bt-ci fails the do-nothing controller (live, 2 seeds)", () => {
  ensureSdk();
  const run = spawnSync(process.execPath, [
    btCi, join(root, "test/controllers/bad.js"),
    "--seeds", "2", "--vs", "brawler,hunter",
    "--sdk-dir", sdkDir, "--report", "/tmp/bt-action-test-bad.json",
  ], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  const report = JSON.parse(readFileSync("/tmp/bt-action-test-bad.json", "utf8"));
  assert.equal(report.passed, false);
  assert.ok(report.failures.length > 0);
});

test("bt-ci rejects a missing controller with usage error", () => {
  const run = spawnSync(process.execPath, [btCi, "no-such-controller.js"], { encoding: "utf8" });
  assert.equal(run.status, 2);
});
