# Contributing to moq-lab

Thanks for considering a contribution. This is a small, self-contained
sandbox, so the bar is: keep it simple, keep it self-contained, and keep the
README in sync with what the code actually does.

## Getting set up

- Docker Desktop running (`docker info` should not error).
- Node.js >=20 and `pnpm` — only needed if you're touching `sgai/` or `lib/`.
  Run `pnpm install` once from the repo root (this also applies
  `patches/@moq__msf.patch`, an upstream packaging fix — nothing to do
  manually).
- No other host dependencies. `ffmpeg`, `moq`, and `moq-relay` all live inside
  the Docker image built by `stream.sh`.

Try the sandbox before changing it, so you have a baseline to compare against:

```bash
./stream.sh bbb                    # single rendition, no ads
./stream.sh bbb --abr-ladder       # ABR ladder
./stream.sh bbb --ssai-mode        # requires assets/ad.mp4
./stream.sh bbb --csai-mode
./stream.sh bbb --sgai-mode        # requires assets/ad.mp4 + pnpm install
```

## Project layout

See [README.md](README.md#project-layout) for the full breakdown of what runs
inside Docker (`run-stream.sh`, `lib/`, `ssai/`, `csai/`) versus on the host
(`stream.sh`, `sgai/`).

## Making changes

- **Keep it self-contained.** Nothing in this repo should end up depending on
  paths, tools, or state outside it.
- **Match the existing style.** Bash scripts use `set -euo pipefail` and
  `>&2` for diagnostics; `.mjs` files are plain ESM with no build step, no
  TypeScript, no bundler.
- **Comments explain *why*, not *what*.** Only add one where the reasoning
  isn't obvious from the code itself (a workaround, a non-obvious ordering
  constraint, a protocol detail) — see the existing files for the tone to
  match. Don't add comments that restate what the next line does.
- **No new dependencies without a reason.** `sgai/`'s `package.json` is
  intentionally minimal (`@moq/net`, `@moq/msf`, `ws`, `zod`). If a change
  needs a new package, explain why in the PR description.
- **Bump pinned versions together.** `moq-cli`/`moq-relay` (`Dockerfile`) and
  `@moq/net`/`@moq/msf` (`package.json`) are pinned on purpose. They move
  fast and have shipped breaking changes between minor versions before —
  bump both sides deliberately and re-run the smoke tests, not just
  `npm outdated`.
- **Update README.md in the same PR.** Behavior changes (new flags, new
  broadcast names, changed defaults) must be reflected in the relevant
  section — this repo has no separate docs site, the README is the docs.

## Testing your change

CI runs two smoke tests end to end on every push/PR (see
`.github/workflows/ci.yml`): `smoke-test-sgai` drives
`ad-decisioning-publisher.mjs` against a real relay and checks the Event
Timeline, blackout, and `%token%` templating a subscriber receives (no
Docker, so no real content broadcast — the Media Timeline needs one, see
below); `smoke-test-docker` builds the actual sandbox image and drives the
base, SSAI, CSAI, and SGAI pipelines (including SSAI combined with
`--abr-ladder`) against a synthetic clip, checking the relay's HTTP API
(broadcast announced, catalog shape, SCTE-35 track present, real Media
Timeline entries flowing, impression-tracker quartile events in the right
order with plausible timing across a pass restart). Neither replaces manual
testing of a real video, real playback, or `--ssai-mode`/`--abr-ladder` —
they check the pipes are wired correctly, not that the stream looks right.
Before opening a PR:

1. Run the mode(s) your change affects (see commands above) and confirm the
   stream plays and terminates cleanly on `Ctrl+C`.
2. For `ssai`/`csai`/`sgai` changes, check the relevant log lines (impression
   tracker events, SCTE-35 cues, or Event Timeline records) match what you'd
   expect from your change.
3. Run the same checks CI runs, locally:

   ```bash
   shellcheck stream.sh run-stream.sh
   find . -path ./node_modules -prune -o -name '*.mjs' -print | xargs -n1 node --check
   ```

### `*.ci-check.mjs` scripts

A few checks are too involved for an inline `run:` step in
`ci.yml` (byte-level comparisons, ordering/timing assertions across a live
container's logs) and live as standalone scripts instead — e.g.
`csai/scte35.ci-check.mjs`, `ssai/impression-tracker.ci-check.mjs`. They're
test-only: nothing in `Dockerfile` or `run-stream.sh` imports them, they
exist purely to be invoked from a CI step. The `*.ci-check.mjs` suffix marks
that at a glance; they live next to the module they check rather than in a
separate `test/` directory, matching how `ssai/`, `csai/`, and `sgai/` each
already keep their own code together. Follow the same convention for new
CI-only verification scripts.

The two smoke-test jobs can also be run locally — see their steps in
   `.github/workflows/ci.yml` for the exact commands.

## Submitting a PR

- One logical change per PR; keep unrelated cleanup out of it.
- Describe *what* changed and *why* — if it fixes a bug, describe the
  symptom you saw and how you confirmed the fix.
- Note which mode(s) you tested (see above) and what you ran.
- CI (lint + the two smoke-test jobs) must pass.

By contributing, you agree your contribution is licensed under this repo's
[MIT license](LICENSE).
