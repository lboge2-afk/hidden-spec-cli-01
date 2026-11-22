# hidden-spec-cli-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lboge2-afk/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lboge2-afk/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend: one patch tool for every AI edit format. It reads a patch in unified diff, SEARCH/REPLACE blocks, V4A, or JSON edits, finds the lines each edit names at the first of three matching tiers (exact, trailing-whitespace-insensitive, fully whitespace-insensitive), and writes every change or none, printing what it changed or why it failed.

## Run it

```sh
node main.ts [options] [PATCH]
```

Options: `--format=NAME` (`auto`, `unified`, `search-replace`, `v4a`, `json`), `--check` (dry run: same output and exit code, no files written), `--strict` (tier 0 matching only). `PATCH` is a patch file, or `-` / absent to read from standard input. The working directory is the root of the tree of text files.

---

<sub>Entered on [make.fun](https://make.fun/?ref=plerr&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
