# Changelog

All notable changes to this repo are documented here. This is a sandbox, not
a versioned library — entries are grouped by date, not by release number, and
the format loosely follows [Keep a Changelog](https://keepachangelog.com/).

When you bump a pinned dependency (`@moq/net`/`@moq/msf` in `package.json`,
`moq-cli`/`moq-relay` in the `Containerfile` — see CONTRIBUTING.md), add an entry
here in the same PR: what moved, from/to which version, and whether you found
any breaking changes worth flagging for the next person to bump.

## Unreleased

### Added
- README: "A note on SCTE 35-2" under section 6, documenting that this repo
  implements SCTE 35-1 only — SCTE 35-2 ("Event-Based Signaling") is its
  declared replacement, not implemented here because the spec is behind
  SCTE's member paywall. Tracked as a known gap (see GitHub issue).

### Changed
- Replaced Docker with Podman as the container runtime, everywhere: renamed
  `Dockerfile` → `Containerfile` and `.dockerignore` → `.containerignore`,
  switched every `docker` invocation in `stream.sh`,
  `sgai/ad-decisioning-publisher.mjs` (the `podman exec`-based ad publish),
  and the CI smoke tests to `podman` (same CLI surface, so no other code
  changes needed). Renamed the CI jobs `smoke-test-docker-*` →
  `smoke-test-podman-*`; no branch protection rule referenced the old names,
  so nothing else to update there. Docs (README.md, CONTRIBUTING.md) updated
  to match, including pointing at Podman's official installer instead of
  Homebrew (Podman's own docs advise against `brew install podman` —
  community-maintained, stability not guaranteed).
- `stream.sh` now bootstraps its own prerequisites instead of requiring
  manual setup: on macOS it runs `podman machine init`/`start` on first use
  if the machine isn't ready yet (a local, disposable VM — `podman machine
  rm` undoes it — so safe to automate, unlike installing Podman itself,
  which stays a manual step), and it runs `pnpm install` automatically
  whenever `--sgai-mode` is passed (a no-op in well under a second once
  already up to date). `./stream.sh bbb --sgai-mode` is now a single command
  end to end on a machine with Podman and Node.js already installed.

- Updated dependencies to the newest versions that need no code changes:
  - `moq-cli` 0.9.5 → 0.10.0 (`Containerfile`).
  - `@moq/net` 0.2.2 → 0.3.5, `@moq/msf` 0.2.0 → 0.2.2, `ws` 8.21.1 →
    8.22.0, `zod` 4.4.3 → 4.6.5, `pnpm` 10.12.3 → 10.34.6. `@moq/msf` 0.2.2
    still needs `patches/@moq__msf.patch`.
  - GitHub Actions: `checkout` v4 → v7, `setup-node` v4 → v7,
    `upload-artifact` v4 → v7, `download-artifact` v4 → v8. The v4 actions
    run on Node.js 20, which GitHub is retiring.
  - CI downloaded `moq-relay` 0.14.3, not the 0.14.5 in the `Containerfile`.
    Both now use 0.14.5.

  Re-tested all pipeline modes end to end. Newer versions were tried and not
  taken:
  - `moq-relay` 0.14.18: it drops SGAI events that are sent close together
    much more often than 0.14.5. Even with the fix below (50 ms between
    events) it still lost one event in 6 local runs of `smoke-test-sgai`.
    0.15+ also renames config keys (`[server]` → `[listen]`, `listen` →
    `bind`).
  - `moq-cli` 0.11+: refuses ffmpeg's `frag_every_frame` output (repeated
    `tfdt` with audio and video). Moving needs new ffmpeg flags in
    `run-stream.sh` and `sgai/ad-decisioning-publisher.mjs`. 0.12+ also
    renames `--client-connect` to `--connect`.
  - `@moq/net` 0.4 / `@moq/msf` 0.3: new `Origin` based API.
    `Broadcast.Producer.requested()` and `readFrameSequence()` are gone, so
    the `sgai/` scripts need a rewrite.
  - `pnpm` 11/12: new major versions, not needed.

- Bumped `@moq/net` 0.2.1 → 0.2.2, `moq-cli` 0.9.4 → 0.9.5, `moq-relay`
  0.14.4 → 0.14.5. No breaking changes found (full `@moq/net` `.d.ts` diff:
  only new optional `origin`/Exclude-Hop fields for federated/clustered
  relay topologies, which this sandbox doesn't use). Re-verified all 6
  pipeline modes (base, SSAI, SSAI+ABR, CSAI incl. blackout, SGAI incl.
  Media Timeline/blackout/token, lightweight signaling-only) end to end
  against real binaries after the bump.

### Fixed
- SGAI: an event could be lost on the way to the subscriber when it was
  sent at the same time as another one. Each event is its own MoQ group,
  and the older of two groups written in the same tick can be skipped. The
  publisher already waited 50 ms inside the Start and End pairs, but not in
  two cases: the blackout timer runs on its own and can fire together with
  `Ad End`, and when the ad broadcast's ANNOUNCE wait lasts the whole break,
  `Ad End` was sent right after `Placement Opportunity Start`. In
  `smoke-test-sgai` this lost `Placement Opportunity Start` in every break.
  Now every event goes through one queue in
  `sgai/ad-decisioning-publisher.mjs` that keeps 50 ms between writes.
- CSAI: the SCTE-35 PID carried no traffic at all until the first real
  Break Start/End cue fired, up to `--ad-break-every` seconds into the
  stream. `moq import ts` builds its catalog from PIDs it has actually seen
  traffic on, so a player that fetched its catalog before that first cue
  never saw the SCTE-35 track — cues kept firing correctly server-side, but
  had no visible effect on that player for the rest of the session.
  `csai/scte35.mjs` gained `buildSpliceNullSection()` (a spec `splice_null()`
  command, no descriptors, nothing for a receiver to act on); `ts-injector.mjs`
  now sends one immediately at stream start and every 2s afterward,
  independent of the ad-break schedule.
- SGAI: `Ad Start` (which carries the per-break ad broadcast's name in
  `segmentation_upid_uri`) could be emitted before that broadcast was
  actually announced on the relay — `publishAdOnce()` only launches
  (detached) the `podman exec`'d `ffmpeg | moq import`, which still has to
  fork, connect, and get its ANNOUNCE processed. A subscriber that reacts to
  `Ad Start` by immediately `FETCH`ing reliably lost that race on a cold
  container (first ad break of a run, before the shell/ffmpeg/moq binaries
  are warm). `sgai/ad-decisioning-publisher.mjs` now waits for the relay's
  own ANNOUNCE via `waitForAnnounced()` before emitting `Ad Start`, capped at
  `min(8s, --ad-break-length)` so a container/ffmpeg/moq failure can't freeze
  every subsequent ad break behind one stuck wait.
- CSAI: Break Start/End `segmentation_descriptor`s never signaled
  `segmentation_duration` — `segmentation_duration_flag` was hardcoded off,
  so a subscriber saw `duration: undefined` on every cue and had no way to
  learn the avail's length without also catching Break End. `csai/scte35.mjs`'s
  `segmentationDescriptor()` gained a `segmentationDurationSeconds` option
  (writes the flag plus the 40-bit duration field, via `writeBitsBig` — the
  field is wider than 32 bits, and `writeBits`'s JS `>>>` shift wraps mod 32
  and would corrupt it); `ts-injector.mjs`'s `fireBreakCue()` now passes
  `--ad-break-length` on both Break Start and Break End.
  `csai/scte35.ci-check.mjs` gained two conformance vectors for the field,
  one large enough to exercise the >32-bit path.

## 2026-08-03

### Added
- `lib/msf-uri.mjs`'s `buildUri()`/`parseUri()`: constructs and parses full
  `moqt://` URLs with the `ns=`/`t=` query convention shown in the
  architecture slides (e.g. `moqt://localhost?ns=bbb-ad-0.hang`), instead of
  the bare `moqt://localhost/<broadcast-name>` path this repo used before.
  Wired into every `segmentation_upid_uri` this repo builds: SGAI's ad upids
  and blackout alt-content upid (`sgai/ad-decisioning-publisher.mjs`), and
  CSAI's blackout alt-content upid (`csai/ts-injector.mjs`). Moved from
  `sgai/msf-uri.mjs` to `lib/msf-uri.mjs` so both CSAI (in-container) and
  SGAI (host-side) scripts can share it.
- `sgai/debug-subscriber.mjs` now parses any upid it receives back into
  `{ endpoint, namespace, track }` via `parseUri()` and logs it alongside the
  `[would] FETCH ad` line.
- This file.

### Fixed
- `stream.sh`'s build-start message still claimed "compiles moq/moq-relay
  from source, can take a few minutes", stale since the Dockerfile switched
  to prebuilt binaries (2026-07-27). Corrected to reflect the real, much
  faster build.

## 2026-08-01

### Added
- Program Blackout Override (`0x18`) for CSAI: `csai/scte35.mjs` gained
  `buildProgramBlackoutOverrideSection()`, wired into `csai/ts-injector.mjs`
  via `--blackout-at`/`--blackout-length`/`--blackout-alt-upid` (now
  available on `--csai-mode`, not just `--sgai-mode`). Same
  `segmentation_type_id`/delivery-restriction-flags/UPID shape as SGAI's
  Event Timeline record, encoded as a real binary `splice_info_section`
  instead of JSON.
- `csai/scte35.ci-check.mjs`: byte-for-byte conformance test comparing
  `csai/scte35.mjs`'s `time_signal` + `segmentation_descriptor` encoder
  against `@astronautlabs/scte35` (independent implementation) across 6
  vectors (Break Start/End, max 33-bit PTS, both Program Blackout Override
  states). Found and worked around two `@astronautlabs/scte35` quirks:
  `spliceCommandType`/descriptor `tag` variant discriminators aren't
  auto-set on fresh construction, only on deserialize.
  Renamed from `csai/scte35.conformance.mjs`.
- `ssai/impression-tracker.ci-check.mjs`: verifies the full quartile-event
  sequence (start/first_quartile/midpoint/third_quartile/complete) across two
  consecutive `run-stream.sh` restart passes, asserting order and timing
  tolerance — not just substring presence. First automated SSAI-specific
  check in CI (previously only base/CSAI/SGAI were covered).
- README: "shared/linear vs per-session" SSAI trade-off table; "MoQ-native
  CSAI" section documenting an architectural idea (reuse SGAI's Event
  Timeline transport for CSAI, decision still client-side) — explicitly not
  implemented, noted as a possible future direction.
- CI: split the single `smoke-test-docker` job (five sequential steps) into
  `smoke-test-docker-build` (builds the image + synthetic clip once, shared
  via artifacts) plus one job per pipeline mode
  (`-base`/`-ssai`/`-ssai-abr`/`-csai`/`-sgai`), so each mode gets its own
  pass/fail check and a failure in one doesn't block the others.

### Changed
- Bumped `@moq/net` 0.2.0 → 0.2.1, `moq-cli` 0.9.3 → 0.9.4, `moq-relay`
  0.14.3 → 0.14.4. No breaking changes found (full `.d.ts` diff: only an
  additive `RemoteError` export). `@moq/msf` stayed at 0.2.0 (out of scope
  for that bump). `@moq/net` 0.2.2 was already out at the time; not taken.
- CI Node version 20 → 24 across all jobs.
- "ANSI/SCTE 35" → "SCTE 35-1" (the April 2026 renumbering — "Digital
  Program Insertion Cueing Message Part 1: Legacy Splice-Based and
  Time-Based Signaling") in `csai/scte35.mjs`'s header comment.

### Fixed
- CSAI/SGAI CI smoke tests were flaky on GitHub Actions' shared runners:
  CSAI polled `moq-cli`'s `verbatim.streamId` (populated only after internal
  PES-level analysis — confirmed to sometimes never appear within 60s) instead
  of the CUEI descriptor `ts-injector.mjs` writes immediately at container
  startup. SGAI used a fixed 20s sleep instead of polling, same risk for its
  `MEDIATIME` check. Switched CSAI to the descriptor (3s instead of 30s+) and
  SGAI to a poll-until-satisfied loop (up to 45s).
- `stream.sh`'s build-start message ("first build compiles moq/moq-relay
  from source, can take a few minutes"), stale since the Dockerfile switched
  to prebuilt binaries.

## 2026-07-29

### Added
- Real Media Timeline for SGAI: `sgai/media-timeline.mjs` subscribes to the
  actual content video track (never affecting playback), reads real
  Group/Object sequence numbers off the wire and the real `tfdt` from each
  fMP4 fragment, and publishes genuine `[mediaTimeMs, [group, object],
  wallClockMs]` entries on a co-published `mediatime` track (`packaging:
  "mediatimeline"`) — one per Group/keyframe. The Event Timeline's `depends`
  field now correctly points at `["mediatime"]` (a real track) instead of the
  content broadcast's name (never a valid track reference).
- `lib/fmp4.mjs`: shared fMP4 box-parsing helpers, extracted from
  `ssai/impression-tracker.mjs` so `sgai/media-timeline.mjs` could reuse them
  on discrete per-object buffers instead of a continuous byte stream.
- `%token%` URI-fragment substitution (`sgai/msf-uri.mjs` at the time, later
  moved to `lib/`) per draft-ietf-moq-msf's Variable Substitution mechanism:
  `--personalized-ads` templates ad upids, `sgai/debug-subscriber.mjs`
  resolves them from its own `--url`'s fragment.
- Program Blackout Override (`0x18`) for SGAI:
  `sgai/event-timeline.mjs`'s `programBlackoutOverride()`, scheduled via
  `--blackout-at`/`--blackout-length`/`--blackout-alt-upid` on
  `ad-decisioning-publisher.mjs`.
- `waitForAnnounced()` moved to `sgai/transport.mjs` as a shared export
  (previously duplicated in `debug-subscriber.mjs`).

### Fixed
- A zombie-process bug found while verifying the above against a live relay:
  an unbounded `fetch()` (no timeout) in the Media Timeline's catalog-lookup
  retry loop could hang forever if the content broadcast never appeared, and
  a declaration-order bug (`running` referenced before its `let` in an async
  IIFE that starts executing immediately) risked a TDZ crash. Fixed with
  `AbortSignal.timeout()` on the fetch and by declaring `running` earlier.

## 2026-07-27

### Changed
- Bumped `@moq/net`/`@moq/msf` 0.1.x → 0.2.0. `@moq/net` 0.2.0 split
  `Broadcast`/`Track` into `Producer`/`Consumer`/`Subscriber`/`Request`
  classes and changed `writeFrame()`'s signature (`{payload, timestamp}`
  instead of bare bytes) — migrated `sgai/ad-decisioning-publisher.mjs` and
  `sgai/debug-subscriber.mjs` accordingly.
- Dockerfile: `moq-cli`/`moq-relay` now downloaded as prebuilt Linux
  binaries from moq-dev/moq's GitHub releases instead of `cargo install`
  from source (5-8 minutes → seconds).

### Added
- Real CI smoke tests (`smoke-test-sgai`, `smoke-test-docker`) replacing
  lint-only CI — this is what would have caught
  `sgai/ad-decisioning-publisher.mjs` being accidentally deleted, which
  lint-only CI never noticed.

## 2026-07-17

### Added
- Initial MoQ streaming sandbox: `stream.sh`/`run-stream.sh`, Dockerfile,
  base/SSAI/CSAI/SGAI pipelines, `--abr-ladder`.
