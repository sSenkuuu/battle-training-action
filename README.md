# battle-training-action

A GitHub Action that tests a [battle.training](https://battle.training/)
controller with the ladder's own engine — and optionally uploads it when the
tests pass.

battle.training is a tank-battle arena for AI coding agents: you write a
JavaScript controller, it fights ranked matches around the clock. The arena's
own docs ([llms.txt](https://api.battle.training/llms.txt)) say to test
locally first and aim for **>60% vs brawler and >50% vs hunter** before
uploading. Until now that check was a manual command. This action makes it a
CI gate: a bad controller fails the PR instead of reaching the ladder.

## What it does

1. Downloads the official SDK (`arena-sim.mjs` + `local-test.mjs` from
   `https://api.battle.training/sdk/`) — the ladder's own engine.
2. Runs `local-test.mjs` against your controller for N seeds against the
   house bots (brawler, holder, random, hunter by default).
3. Parses the summary and enforces thresholds. Defaults are the arena's own
   targets: overall ≥ 50%, brawler ≥ 60%, hunter ≥ 50%, refused orders ≤ 20
   per game, **0 tick errors** (a throwing `tick()` sends empty orders on the
   ladder, so it must never ship).
4. Writes a JSON report and a Markdown summary (posted to the job summary).
5. With `upload: true` — and only if the tests passed — uploads the
   controller as a new version of your bot (`POST /api/bots/<bot>/versions`).
   The API key is never printed in logs.

## Usage

```yaml
- uses: sSenkuuu/battle-training-action@v1
  with:
    controller: controller.js
    seeds: 10
```

Full example (copy `.github/workflows/test-controller.yml` into your bot repo):

```yaml
- name: Test controller vs house bots
  id: bt
  uses: sSenkuuu/battle-training-action@v1
  with:
    controller: controller.js
    seeds: 10
    opponents: brawler,holder,random,hunter
    # upload: true
    # bot: ssenkuuu-bot
    # label: v1
    # api-key: ${{ secrets.BT_API_KEY }}
```

### Inputs

| Input | Default | Description |
| --- | --- | --- |
| `controller` | `controller.js` | Path to the controller file |
| `seeds` | `10` | Seeds per opponent (games = seeds × opponents × 2 sides) |
| `opponents` | `brawler,holder,random,hunter` | House bots to play |
| `rules` | `s2` | Ruleset: `s2`, `s1`, `sub`, `urban`, or a full version string |
| `min-win-rate` | `50` | Minimum overall win rate (%) |
| `min-brawler` | `60` | Minimum win rate (%) vs brawler |
| `min-hunter` | `50` | Minimum win rate (%) vs hunter |
| `max-refused` | `20` | Maximum refused orders per game |
| `upload` | `false` | Upload on green (`true`/`false`) |
| `bot` | — | Bot name (required when `upload: true`) |
| `label` | `v1` | Version label for the upload |
| `api-key` | — | battle.training API key (`BT_API_KEY` secret). Never printed. |

### Outputs

`win-rate`, `games`, `passed`, `report-path`.

## Local use (no GitHub needed)

```sh
node scripts/bt-ci.mjs controller.js --seeds 10 --vs brawler,holder,random,hunter --sdk-dir .bt-sdk --download-sdk
node scripts/bt-ci.mjs controller.js --seeds 10 --upload --bot ssenkuuu-bot --label v2 --api-key "$BT_API_KEY" --sdk-dir .bt-sdk
```

Requires Node 20+. Exit codes: 0 pass, 1 tests/thresholds/upload failed,
2 usage error.

## Demo: ssenkuuu-bot v1

`examples/ssenkuuu-bot/` holds the exact controller uploaded as v1 of
[ssenkuuu-bot](https://battle.training/bots/ssenkuuu-bot), enrolled in the
promotedby.ai November Cup. Verified locally with the official harness:

| Run | Overall | vs brawler | vs holder | vs random | vs hunter |
| --- | --- | --- | --- | --- | --- |
| 20 seeds, 160 games | **69.4%** (111-49) | 72.5% | 42.5% | 100% | 62.5% |
| 10 seeds, 80 games | **70.0%** (56-24) | 70.0% | 45.0% | 100% | 65.0% |
| 5 seeds, 40 games | **67.5%** (27-13) | 60.0% | 40.0% | 100% | 70.0% |
| starter, 20 seeds | 60.0% (96-64) | 67.5% | 35.0% | 82.5% | 55.0% |

The action's self-test (`.github/workflows/self-test.yml`) runs this
controller on every push at 10 seeds with the arena's default thresholds.

## Tests

```sh
node --test test/bt-ci.test.mjs
```

7 tests: summary parsing (against a real captured harness output), threshold
checks, and live runs — the example controller passes, a do-nothing
controller fails, a missing controller is a usage error. The upload path is
covered by `scripts/upload.mjs` (verified against a local mock of the API;
no real upload happens in tests).

## Why a GitHub Action, not another MCP server

The official MCP server at `https://api.battle.training/mcp` already covers
account creation, uploads and ladder reads, and community MCP wrappers exist
on Glama. What did not exist was CI: every bot author re-runs the same
manual local-test command before uploading, with nothing stopping a bad
version from shipping. This action closes exactly that gap, using the
arena's own engine and its own published targets.

## License

MIT. battle.training is operated by Euler's Identity, LLC; this action is an
independent community integration, not affiliated with or endorsed by them.
Replays and ladder data quoted here are battle.training's, CC BY 4.0.
