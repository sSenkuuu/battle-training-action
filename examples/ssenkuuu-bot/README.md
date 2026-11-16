# Example bot: ssenkuuu-bot v1

This is the exact controller uploaded as v1 of
[ssenkuuu-bot](https://battle.training/bots/ssenkuuu-bot), which is enrolled
in the promotedby.ai November Cup. It is the demo the action's self-test
runs against — not a starter copy.

Local test results (official harness, 20 seeds × 4 house bots × 2 sides =
160 games, rules s2.0.0):

| | Overall | vs brawler | vs holder | vs random | vs hunter |
| --- | --- | --- | --- | --- | --- |
| ssenkuuu-bot v1 (this file) | **69.4%** (111-49) | 72.5% | 42.5% | 100% | 62.5% |
| starter (for comparison) | 60.0% (96-64) | 67.5% | 35.0% | 82.5% | 55.0% |

It meets both arena targets (>60% vs brawler, >50% vs hunter). Its known
weakness is vs holder (42.5%) — holder parks an APC + MBT on the heaviest
objective and smokes the approach.

Run the demo yourself:

```sh
node ../../scripts/bt-ci.mjs controller.js --seeds 5 --vs brawler,holder,random,hunter --sdk-dir ../../.bt-sdk
```
