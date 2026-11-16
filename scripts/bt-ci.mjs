#!/usr/bin/env node
// bt-ci — run the battle.training local-test harness in CI and gate on results.
//
//   node bt-ci.mjs <controller.js> [--seeds 10] [--vs brawler,holder,random,hunter]
//     [--rules s2] [--min-win-rate 50] [--min-brawler 60] [--min-hunter 50]
//     [--max-refused 20] [--sdk-dir .bt-sdk] [--download-sdk]
//     [--report report.json] [--summary summary.md]
//     [--upload] [--bot <name>] [--label v1] [--api-key $BT_API_KEY]
//
// What it does:
//   1. Makes sure the official SDK is present (arena-sim.mjs + local-test.mjs
//      from https://api.battle.training/sdk/, or a local --sdk-dir).
//   2. Runs `node local-test.mjs <controller> --seeds N --vs ... --rules ...`
//      — the ladder's own engine, same as `node local-test.mjs` by hand.
//   3. Parses the summary it prints and enforces thresholds. The defaults are
//      the arena's own targets from llms.txt: >60% vs brawler, >50% vs hunter.
//      Any tick() error fails the run outright: a controller that throws
//      sends empty orders on the ladder, so it must never ship.
//   4. Writes a machine-readable report (JSON) and a Markdown summary
//      (for $GITHUB_STEP_SUMMARY) and exits 0 on pass, 1 on failure.
//   5. With --upload (and only if the tests passed) uploads the controller
//      as a new version of --bot via POST /api/bots/<bot>/versions.
//      The API key is read from --api-key or BT_API_KEY and is never printed.
//
// Exit codes: 0 pass, 1 tests/thresholds/upload failed, 2 usage error.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { uploadVersion } from "./upload.mjs";

const API_BASE = process.env.BT_API_BASE ?? "https://api.battle.training";
const SDK_FILES = ["arena-sim.mjs", "local-test.mjs"];

const USAGE = `usage: node bt-ci.mjs <controller.js> [--seeds N] [--vs brawler,holder,random,hunter]
[--rules s2|s1|sub|urban|<version>] [--min-win-rate 50] [--min-brawler 60]
[--min-hunter 50] [--max-refused 20] [--sdk-dir .bt-sdk] [--download-sdk]
[--report report.json] [--summary summary.md]
[--upload] [--bot <name>] [--label v1] [--api-key $BT_API_KEY]`;

function fail(msg) {
console.error(`bt-ci: ${msg}`);
process.exit(2);
}

function parseArgs(argv) {
const positional = [];
const opts = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--help" || a === "-h") {
    console.log(USAGE);
    process.exit(0);
  }
  if (a.startsWith("--")) {
    const key = a.slice(2);
    if (["upload", "download-sdk"].includes(key)) {
      opts[key] = true;
    } else {
      const value = argv[++i];
      if (value === undefined) fail(`missing value for ${a}`);
      opts[key] = value;
    }
  } else {
    positional.push(a);
  }
}
return { positional, opts };
}

let positional, opts, controller, seeds, opponents, rules, thresholds, sdkDir, reportPath, summaryPath;

function initCli() {
  ({ positional, opts } = parseArgs(process.argv.slice(2)));
  controller = positional[0];
  if (!controller) fail(`no controller given\n${USAGE}`);
  if (!existsSync(controller)) fail(`controller not found: ${controller}`);

  seeds = Number(opts.seeds ?? 10);
  opponents = String(opts.vs ?? "brawler,holder,random,hunter");
  rules = String(opts.rules ?? "s2");
  thresholds = {
    minWinRate: Number(opts["min-win-rate"] ?? 50),
    minBrawler: Number(opts["min-brawler"] ?? 60),
    minHunter: Number(opts["min-hunter"] ?? 50),
    maxRefused: Number(opts["max-refused"] ?? 20),
  };
  for (const [k, v] of Object.entries(thresholds)) {
    if (!Number.isFinite(v)) fail(`--${k} must be a number, got ${opts[k]}`);
  }
  if (!Number.isInteger(seeds) || seeds < 1) fail("--seeds must be a positive integer");

  sdkDir = resolve(opts["sdk-dir"] ?? ".bt-sdk");
  reportPath = opts.report ? resolve(opts.report) : null;
  summaryPath = opts.summary ? resolve(opts.summary) : null;
}

async function ensureSdk() {
  const missing = SDK_FILES.filter((f) => !existsSync(join(sdkDir, f)));
  if (missing.length === 0) return;
  if (!opts["download-sdk"] && !process.env.BT_DOWNLOAD_SDK) {
    fail(
      `SDK missing in ${sdkDir} (${missing.join(", ")}). ` +
        `Re-run with --download-sdk, or point --sdk-dir at a folder holding ` +
        `arena-sim.mjs + local-test.mjs from https://api.battle.training/sdk/.`,
    );
  }
  mkdirSync(sdkDir, { recursive: true });
  for (const file of missing) {
    const url = `https://api.battle.training/sdk/${file}`;
    console.log(`bt-ci: downloading ${url}`);
    const res = await fetch(url, { headers: { "User-Agent": "battle-training-action/1.0" } });
    if (!res.ok) fail(`downloading ${url} failed: HTTP ${res.status}`);
    writeFileSync(join(sdkDir, file), await res.text(), "utf8");
  }
}

/** Parse the `=== summary ===` block local-test.mjs prints. */
export function parseLocalTestOutput(text) {
  const games = text.match(/games (\d+)\s+W-L-D (\d+)-(\d+)-(\d+)\s+win rate ([\d.]+)%/);
  if (!games) throw new Error("could not find the summary line in local-test output");
  const perOpponent = {};
  for (const m of text.matchAll(/vs (\w+)\s+(\d+)-(\d+)-(\d+)/g)) {
    perOpponent[m[1]] = { w: Number(m[2]), l: Number(m[3]), d: Number(m[4]) };
  }
  const damage = text.match(/damage dealt\/taken per game (\d+)\/(\d+)\s+refused orders per game ([\d.]+)\s+tick errors (\d+) in \d+\/(\d+) games\s+matches aborted (\d+)/);
  const rulesLine = text.match(/^rules (\S+)/m);
  const verified = text.match(/replays verified (\d+)\/(\d+)/);
  return {
    games: Number(games[1]),
    wins: Number(games[2]),
    losses: Number(games[3]),
    draws: Number(games[4]),
    winRate: Number(games[5]),
    perOpponent,
    damageDealtPerGame: damage ? Number(damage[1]) : null,
    damageTakenPerGame: damage ? Number(damage[2]) : null,
    refusedPerGame: damage ? Number(damage[3]) : null,
    tickErrors: damage ? Number(damage[4]) : null,
    matchesAborted: damage ? Number(damage[6]) : null,
    replaysVerified: verified ? `${verified[1]}/${verified[2]}` : null,
    rules: rulesLine ? rulesLine[1] : rules,
  };
}

/** Check the parsed result against the thresholds. Returns a list of failures. */
export function checkThresholds(result, t) {
  const failures = [];
  if (result.winRate < t.minWinRate) {
    failures.push(`overall win rate ${result.winRate}% < ${t.minWinRate}%`);
  }
  for (const [opp, min] of [["brawler", t.minBrawler], ["hunter", t.minHunter]]) {
    const r = result.perOpponent[opp];
    if (!r) continue; // opponent not run: nothing to check
    const games = r.w + r.l + r.d;
    const rate = games ? (100 * r.w) / games : 0;
    if (rate < min) failures.push(`vs ${opp} ${rate.toFixed(1)}% < ${min}%`);
  }
  if (result.tickErrors > 0) {
    failures.push(`${result.tickErrors} tick() error(s) — a throwing tick sends empty orders on the ladder`);
  }
  if (result.matchesAborted > 0) {
    failures.push(`${result.matchesAborted} match(es) aborted`);
  }
  if (result.refusedPerGame !== null && result.refusedPerGame > t.maxRefused) {
    failures.push(`refused orders ${result.refusedPerGame}/game > ${t.maxRefused}/game`);
  }
  return failures;
}

function renderSummary(result, failures, upload) {
  const rows = Object.entries(result.perOpponent)
    .map(([opp, r]) => {
      const games = r.w + r.l + r.d;
      const rate = games ? ((100 * r.w) / games).toFixed(1) : "0.0";
      return `| ${opp} | ${r.w}-${r.l}-${r.d} | ${rate}% |`;
    })
    .join("\n");
  const verdict = failures.length === 0 ? "✅ PASS" : "❌ FAIL";
  return [
    `## battle.training — local test ${verdict}`,
    ``,
    `Controller: \`${controller}\` · rules \`${result.rules}\` · ${result.games} games ` +
      `(${result.wins}-${result.losses}-${result.draws}) · win rate **${result.winRate}%**`,
    ``,
    `| Opponent | W-L-D | Win rate |`,
    `| --- | --- | --- |`,
    rows,
    ``,
    `Damage dealt/taken per game: ${result.damageDealtPerGame}/${result.damageTakenPerGame} · ` +
      `refused orders/game: ${result.refusedPerGame} · tick errors: ${result.tickErrors} · ` +
      `replays verified: ${result.replaysVerified ?? "n/a"}`,
    ``,
    failures.length
      ? `### Failures\n\n${failures.map((f) => `- ${f}`).join("\n")}\n`
      : `Thresholds met: overall ≥ ${thresholds.minWinRate}%, brawler ≥ ${thresholds.minBrawler}%, ` +
        `hunter ≥ ${thresholds.minHunter}%, refused ≤ ${thresholds.maxRefused}/game, 0 tick errors.\n`,
    upload ? `Upload: ${upload}\n` : ``,
  ].join("\n");
}

async function main() {
  initCli();
  await ensureSdk();

  console.log(
    `bt-ci: testing ${controller} — ${seeds} seeds vs ${opponents} (rules ${rules})`,
  );
  const run = spawnSync(
    process.execPath,
    [join(sdkDir, "local-test.mjs"), resolve(controller), "--seeds", String(seeds), "--vs", opponents, "--rules", rules],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  process.stdout.write(run.stdout ?? "");
  process.stderr.write(run.stderr ?? "");
  if (run.error) fail(`could not run local-test.mjs: ${run.error.message}`);
  if (run.status !== 0) {
    console.error(`bt-ci: local-test.mjs exited with code ${run.status}`);
    process.exit(1);
  }

  let result;
  try {
    result = parseLocalTestOutput(run.stdout);
  } catch (e) {
    console.error(`bt-ci: ${e.message}`);
    process.exit(1);
  }
  const failures = checkThresholds(result, thresholds);

  let uploadNote = "";
  if (opts.upload) {
    if (failures.length > 0) {
      console.log("bt-ci: tests failed — skipping upload.");
      uploadNote = "skipped (tests failed)";
    } else {
      const apiKey = opts["api-key"] ?? process.env.BT_API_KEY;
      const bot = opts.bot;
      if (!apiKey) fail("--upload needs an API key: --api-key or BT_API_KEY");
      if (!bot) fail("--upload needs --bot <name>");
      const label = opts.label ?? "v1";
      console.log(`bt-ci: uploading ${controller} as ${bot} version ${label}…`);
      try {
        const uploaded = await uploadVersion({
          apiBase: API_BASE,
          apiKey,
          bot,
          label,
          source: readFileSync(resolve(controller), "utf8"),
        });
        uploadNote = `uploaded as ${bot} version \`${label}\` (${uploaded.versionId ?? "ok"}) — smoke test ${uploaded.smoke ?? "passed"}`;
        console.log(`bt-ci: ${uploadNote}`);
      } catch (e) {
        failures.push(`upload failed: ${e.message}`);
        uploadNote = `failed: ${e.message}`;
      }
    }
  }

  const report = {
    controller,
    rules: result.rules,
    seeds,
    opponents: opponents.split(","),
    ...result,
    thresholds,
    failures,
    passed: failures.length === 0,
    upload: uploadNote || null,
    generatedAt: new Date().toISOString(),
  };
  if (reportPath) {
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(`bt-ci: report written to ${reportPath}`);
  }
  const summary = renderSummary(result, failures, uploadNote || null);
  if (summaryPath) writeFileSync(summaryPath, summary, "utf8");
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
  }

  if (failures.length > 0) {
    console.error(`\nbt-ci: FAIL\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`\nbt-ci: PASS — win rate ${result.winRate}% over ${result.games} games`);


}

// Only run the CLI when executed directly, not when imported (tests import
// parseLocalTestOutput / checkThresholds from this file).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
