# Changelog

All notable changes to this repo are documented here. This is a sandbox, not
a versioned library — entries are grouped by date, not by release number, and
the format loosely follows [Keep a Changelog](https://keepachangelog.com/).

When you bump a pinned dependency (`@moq/net`/`@moq/msf` in `package.json`,
`moq-cli`/`moq-relay` in the `Dockerfile` — see CONTRIBUTING.md), add an entry
here in the same PR: what moved, from/to which version, and whether you found
any breaking changes worth flagging for the next person to bump.

## Unreleased

### Changed
- Bumped `@moq/net` 0.2.1 → 0.2.2, `moq-cli` 0.9.4 → 0.9.5, `moq-relay`
  0.14.4 → 0.14.5. No breaking changes found (full `@moq/net` `.d.ts` diff:
  only new optional `origin`/Exclude-Hop fields for federated/clustered
  relay topologies, which this sandbox doesn't use). Re-verified all 6
  pipeline modes (base, SSAI, SSAI+ABR, CSAI incl. blackout, SGAI incl.
  Media Timeline/blackout/token, lightweight signaling-only) end to end
  against real binaries after the bump.

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
