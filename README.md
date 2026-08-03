# moq-lab

[![CI](https://github.com/pzanella/moq-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/pzanella/moq-lab/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A local sandbox for spinning up MoQ (Media over QUIC) streams: single
rendition or a full ABR ladder, with or without SSAI, CSAI, or SGAI
ad-insertion — no tools needed beyond Docker (and Node.js, for SGAI only).

This repo is **self-contained**: it has no dependency on anything outside it
(own `package.json`, own `pnpm-workspace.yaml`, own `assets/`).

## Contents

1. [Project layout](#project-layout)
2. [How it works](#how-it-works)
3. [Requirements](#1-requirements)
4. [Add your video files](#2-add-your-video-files)
5. [Run it](#3-run-it)
6. [What you get](#4-what-you-get)
7. [SSAI: ad insertion and impression tracking](#5-ssai-ad-insertion-and-impression-tracking)
8. [CSAI: SCTE-35 signaling](#6-csai-scte-35-signaling)
9. [SGAI: Event Timeline signaling](#7-sgai-event-timeline-signaling)
10. [Relay HTTP API](#8-relay-http-api)
11. [Troubleshooting](#9-troubleshooting)
12. [Contributing](#contributing)
13. [Acknowledgments](#acknowledgments)

---

## Project layout

```
moq-lab/
├── stream.sh              ← you run this
├── run-stream.sh          ← runs inside the container
├── Dockerfile
├── package.json           ← host-side Node deps, used only by sgai/
├── pnpm-workspace.yaml    ← marks this repo as its own pnpm project
├── assets/                ← your local test videos (gitignored)
├── lib/                   ← shared helpers (logger, CLI arg parsing, fMP4 box parsing, MOQ URLs)
├── ssai/                  ← Server-Side Ad Insertion (in-container proxy)
├── csai/                  ← CSAI SCTE-35 signaling (in-container proxy)
└── sgai/                  ← Server-Guided Ad Insertion (host-side publisher)
```

`ssai/` and `csai/` run **inside** the Docker image (copied in by the
`Dockerfile`) — they're pure Node with no npm dependencies. `sgai/` runs on
**your host**, outside Docker, and is the only part of this sandbox with
external dependencies (`@moq/net`, `@moq/msf`, `ws`, `zod` — installed via
this repo's own `package.json`).

---

## How it works

- **`Dockerfile`** builds an image with `ffmpeg`, `moq` (the `moq-cli`
  publisher/subscriber binary), and `moq-relay` pre-installed — as prebuilt
  Linux binaries downloaded from moq-dev/moq's GitHub releases, not compiled
  from source, so the build is fast.
- **`run-stream.sh`** runs inside the container: it transcodes your video,
  starts the relay, and feeds the stream into `moq` as the publisher.
- **`stream.sh`** is what you actually call. It builds the Docker image and
  starts the container for you.

This sandbox has two independent dimensions, which you combine with flags:

| Dimension | Flag | What it changes |
|---|---|---|
| Rendition ladder | `--abr-ladder` | One stream vs. a 5-rendition ABR ladder (240p–1080p) |
| Ad insertion mode | `--ssai-mode` / `--csai-mode` / `--sgai-mode` | Off by default; the three are mutually exclusive |

That's 2 × 4 (no ad mode, SSAI, CSAI, SGAI) = 8 runnable combinations, all
described below.

**SSAI** (`--ssai-mode`, Server-Side Ad Insertion) splices real ad video into
the content stream server-side, in a continuous loop, as one already-stitched
track — the client has no visibility into where the ad break is. See [section
5](#5-ssai-ad-insertion-and-impression-tracking).

**CSAI** (`--csai-mode`, client-side ad insertion signaling) leaves the
content stream untouched and adds a real SCTE-35 Break Start/Break End track
alongside it, for a client to subscribe to and act on itself — no server-side
switching. See [section 6](#6-csai-scte-35-signaling).

**SGAI** (`--sgai-mode`, Server-Guided Ad Insertion) is in between: content,
ad, and ad-decisioning signaling are published as three **independent** MoQ
broadcasts, and a subscriber is expected to consume the signaling track to
decide when to switch between the content and ad broadcasts itself — the
server signals the opportunity, but doesn't splice anything. See [section
7](#7-sgai-event-timeline-signaling).

---

## 1. Requirements

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed
  and running (`docker info` should not print an error).
- For `--sgai-mode` only: Node.js >=20 (its host-side signaling script runs
  outside Docker) and `pnpm install` run once, from the repo root — see
  section 7. This also applies `patches/@moq__msf.patch`, a one-line fix for
  a missing `.js` extension in `@moq/msf`'s own ESM export map (an upstream
  packaging bug, not something this repo's code needs) — pnpm applies it
  automatically, no separate step required.

---

## 2. Add your video files

Place `.mp4` files in `assets/`:

```
moq-lab/
├── assets/
│   ├── bbb.mp4     ← your content video (any name)
│   └── ad.mp4      ← your ad video (must be named exactly ad.mp4)
├── stream.sh
└── ...
```

**Content video** (`assets/<name>.mp4`): any H.264/AAC MP4. You pass `<name>`
on the command line. The file is mounted read-only inside the container.

**Ad video** (`assets/ad.mp4`): only needed for `--ssai-mode` and
`--sgai-mode`. The name is fixed — it must be `ad.mp4`. The server normalises
its resolution, frame rate, and sample rate automatically to match the
content, so the source file can have different encoding parameters.

`assets/*.mp4` is gitignored (see `assets/.gitignore`), so your videos stay
local.

---

## 3. Run it

All commands below are run from the repo root.

### Basic stream (no ads)

```bash
# Default: uses assets/bbb.mp4, single rendition, port 4443
./stream.sh bbb

# Different content file (assets/<name>.mp4)
./stream.sh tos

# 5-rendition ABR ladder (240p / 360p / 480p / 720p / 1080p)
./stream.sh bbb --abr-ladder

# Custom port
./stream.sh bbb --port 4444
```

### SSAI: Server-Side Ad Insertion

Requires `assets/ad.mp4` to exist.

```bash
# SSAI with default settings (ad break every 30 seconds)
./stream.sh bbb --ssai-mode

# Custom ad break interval (e.g. every 60 seconds)
./stream.sh bbb --ssai-mode --ad-break-every 60

# SSAI + ABR ladder
./stream.sh bbb --ssai-mode --abr-ladder

# SSAI + ABR ladder + custom port
./stream.sh bbb --ssai-mode --abr-ladder --port 4444 --ad-break-every 45
```

### CSAI: SCTE-35 signaling

No `assets/ad.mp4` needed — no ad video is interleaved. The content stream
plays continuously (single rendition or `--abr-ladder`); a SCTE-35 Break
Start/Break End track is added alongside it for a client to subscribe to and
act on. See [section 6](#6-csai-scte-35-signaling) for details.

```bash
# CSAI with default settings (a break every 30s, 6s between Start and End)
./stream.sh bbb --csai-mode

# Custom cadence: a break every 60s, lasting 10s
./stream.sh bbb --csai-mode --ad-break-every 60 --ad-break-length 10

# CSAI + ABR ladder
./stream.sh bbb --csai-mode --abr-ladder
```

### SGAI: Event Timeline signaling

Requires `assets/ad.mp4` to exist, and (once) `pnpm install` run from this
folder. See [section 7](#7-sgai-event-timeline-signaling) for details.

```bash
# SGAI with default settings (a break every 30s; ad break length is
# assets/ad.mp4's own duration, auto-detected)
./stream.sh bbb --sgai-mode

# Custom cadence
./stream.sh bbb --sgai-mode --ad-break-every 60

# SGAI + ABR ladder
./stream.sh bbb --sgai-mode --abr-ladder
```

To test a different ad break length, use a different `assets/ad.mp4` — SGAI
always uses the file's real duration (see [section
7](#7-sgai-event-timeline-signaling)).

`--ssai-mode`, `--csai-mode`, and `--sgai-mode` are mutually exclusive — each
uses a different pipeline.

### All flags at a glance

| Flag | Default | Description |
|---|---|---|
| `<name>` | `bbb` | Content file to stream (`assets/<name>.mp4`) |
| `--abr-ladder` | off | Encode a 5-rendition ABR ladder instead of a single stream |
| `--port N` | `4443` | Port for both the QUIC relay and the HTTP API |
| `--ssai-mode` | off | Interleave `assets/ad.mp4` as a recurring, server-stitched ad break |
| `--ad-break-every N` | `30` | Seconds of content between ad breaks. Shared by all three ad modes |
| `--csai-mode` | off | Add a Break Start/Break End SCTE-35 track; no ad video is interleaved |
| `--ad-break-length N` | `6` | CSAI only: seconds between Break Start and Break End |
| `--sgai-mode` | off | Publish content, ad, and Event Timeline signaling as independent broadcasts |
| `--blackout-at N` | off | CSAI or SGAI: fire a one-shot Program Blackout Override N seconds in |
| `--blackout-length N` | `10` | CSAI or SGAI: seconds until the blackout restores |
| `--personalized-ads` | off | SGAI only: template ad upids with a `%token%` placeholder |

### npm/pnpm shortcut

```bash
pnpm stream                  # same as: ./stream.sh bbb
```

---

## 4. What you get

### Stream URL

```
https://localhost:4443
```

The relay uses a self-signed TLS certificate (generated at startup). Your
browser will warn about it; accept it once and the player will work.

### Broadcast names

| Mode | Broadcast name(s) |
|---|---|
| Single rendition | `<name>.hang` |
| `--abr-ladder` | `<name>.multi.hang` |
| `--sgai-mode`, additionally | `<name>-events` (signaling), `<name>-ad-N.hang` (one per ad break, N incrementing) |

Point the player's `moq` config at the URL and broadcast name:

```javascript
moq: {
    url: "https://localhost:4443",
    namespace: "bbb.hang",
    // ... other player settings
}
```

Press `Ctrl+C` to stop the stream.

---

## 5. SSAI: ad insertion and impression tracking

**Architecture note — shared/linear, not per-session.** This sandbox's SSAI
splices one ad break into one continuously-looping stream, shared by every
viewer who subscribes to the broadcast — the same model as a linear TV
channel's server-side ad insertion. Every viewer sees the same ad at the
same point, and there is no per-viewer ad selection. This is *not* the
"per-session" model most production SSAI (Yospace, FreeWheel/GAM DAI-style)
uses today, where each viewer session gets its own manifest/stream stitched
with ads selected for that specific viewer (targeting, frequency capping,
personalized creative). Trade-offs:

| | Shared/linear (this repo) | Per-session (industry standard) |
|---|---|---|
| Ad selection | One ad for all viewers | Selected per viewer/session |
| Server cost | One encode/stitch, fans out to N viewers | One stitched output per session |
| Targeting, frequency capping | Not possible | Core use case |
| Complexity | Low — matches this sandbox's scope | Requires per-session ad decisioning + stitching at scale |

Extending this to per-session SSAI is a real architectural change (session
state, per-viewer stitching or manifest manipulation), not a flag — it's not
implemented here. SGAI's `--personalized-ads`/`%token%` mechanism (section 7)
addresses personalization for the *signaling* path, not for SSAI's spliced
stream.

When you pass `--ssai-mode`, the pipeline works like this:

```
ffmpeg (concat filter) → ssai/impression-tracker.mjs → moq import fmp4 → relay → player
```

**What ffmpeg does**: it builds a loop of content segments interleaved with
the normalised ad. Each cycle looks like:

```
[content segment — N seconds] [ad video — auto-detected duration]
```

The cycle repeats continuously. The ad duration is read automatically from
the ad file with `ffprobe` — you do not need to pass it manually.

**What the impression tracker does**: `ssai/impression-tracker.mjs` is a
transparent byte-stream proxy. Every byte that comes from `ffmpeg` is passed
unchanged to `moq`. At the same time, the proxy reads the fMP4 box structure
from the stream and watches the video timestamps (`tfdt` values inside
`moof` boxes). When a timestamp crosses a quartile threshold within the ad
segment, the proxy logs it to `stderr`:

```
[SSAI] 2026-06-23T10:00:00.000Z adBreakEvery=30 adBreakLength=28.421
[SSAI] 2026-06-23T10:00:30.012Z break=0 | start            |  0% | streamSecs=30.000
[SSAI] 2026-06-23T10:00:37.112Z break=0 | first_quartile   | 25% | streamSecs=37.105
[SSAI] 2026-06-23T10:00:44.212Z break=0 | midpoint         | 50% | streamSecs=44.210
[SSAI] 2026-06-23T10:00:51.312Z break=0 | third_quartile   | 75% | streamSecs=51.315
[SSAI] 2026-06-23T10:00:58.421Z break=0 | complete         | 100% | nominalSecs=58.421
```

No HTTP requests are made. No timers are used. The timing comes entirely from
the fMP4 stream PTS, so it is accurate to the frame. This logging is local to
the sandbox for debugging — it is not delivered to the client over any MoQ
track. The client receives a single, already-stitched stream and has no
visibility into where the ad break is; that is the defining trait of SSAI.

**Note on timing**: the proxy fires events when the frame data enters the
publishing pipeline. Because the player buffers a few seconds of video, the
viewer will see each event a short time after it is logged. This is expected
for server-side tracking.

**Current limitation — slow startup**: the concat filtergraph opens up to
`N_CYCLES × 2` (up to 40) separate `ffmpeg` inputs upfront — a content segment
and the ad, per cycle — each doing its own accurate seek (`-ss`) into the same
source file. Building and seeking into all of them before the first frame
reaches the encoder measurably takes on the order of ~15 seconds on ordinary
hardware, independent of `--abr-ladder` (measured nearly identical with and
without it). Once running, timing is frame-accurate with no ongoing drift —
the delay is a one-time startup cost, not a precision problem — but it means
the first ad break lands ~15s later in wall-clock time than
`--ad-break-every`'s value would suggest if you're timing from when you ran
`stream.sh` rather than from the first frame the player receives. Fixing this
properly needs a different input architecture (e.g. one continuous input with
`trim`/`atrim` instead of N separately-seeked inputs) and hasn't been done yet.

---

## 6. CSAI: SCTE-35 signaling

When you pass `--csai-mode`, the pipeline works like this:

```
ffmpeg (remux to MPEG-TS) → csai/ts-injector.mjs → moq import ts → relay → player
```

**Why MPEG-TS**: `moq import ts` demuxes an incoming MPEG-TS stream and
auto-generates a catalog with a `video`/`audio` section (same as the fmp4
pipeline) plus an `mpegts.tracks` section describing every PID it saw. Any PID
it can't decode as a known audio/video codec — like a private SCTE-35
stream — is exposed as an opaque `"verbatim"` track instead of being dropped.
This is the same mechanism a real SCTE-35-aware backend uses, so the catalog
shape here matches production:

```json
"mpegts": {
  "tracks": {
    "0.avc3": { "pid": 256 },
    "0.aac": { "pid": 257 },
    "0.ts": {
      "pid": 496,
      "descriptors": [{ "tag": 5, "data": "Q1VFSQ==" }],
      "verbatim": { "streamType": 6, "framing": "pes", "streamId": 252 }
    }
  }
}
```

`"0.ts"` is the SCTE-35 track — `streamId: 252` (`0xFC`) is the PES stream ID
SCTE-35 reserves for `splice_info_section`s, and the `descriptors` entry is the
standard `CUEI` registration descriptor (base64 for `"CUEI"`) that marks the
PID as SCTE-35 in the PMT. A client subscribes to that track name directly —
there is no separate broadcast or side channel. `--abr-ladder` works the same
way here as everywhere else: the extra video renditions and the SCTE-35 track
all live in the same catalog.

**What ts-injector.mjs does**: like `ssai/impression-tracker.mjs`, it's a
transparent byte-stream proxy sitting between `ffmpeg` and `moq`. Every TS
packet is passed through unchanged, except:

- The PMT, which it rewrites (once per repetition, recomputing the CRC) to add
  the SCTE-35 elementary stream on a synthesized free PID.
- On a schedule driven by the video elementary stream's own PES decode
  timestamps (`--ad-break-every` / `--ad-break-length`, read against the
  video PID's DTS — falling back to PTS for frames without B-reordering, same
  idea as `ssai/impression-tracker.mjs`'s `tfdt` reads), it splices in a real,
  CRC-valid SCTE-35 `splice_info_section` — a `time_signal` command with a
  `segmentation_descriptor` for Break Start (`0x22`) or Break End (`0x23`) —
  wrapped in a PES packet, on that PID. The encoder lives in `csai/scte35.mjs`.
  Because this reads real timestamps rather than the wall clock, cues stay
  accurate even if `ffmpeg` falls behind real-time under load (e.g. a heavy
  `--abr-ladder` encode).
- Optionally (`--blackout-at`), a one-shot Program Blackout Override (`0x18`)
  cue — see "Regional blackout" below.

```
[CSAI] 2026-07-15T14:03:44.722Z Break Start (event_id=0x3e8, pts=2702250, pid=496)
[CSAI] 2026-07-15T14:03:47.722Z Break End (event_id=0x3e8, pts=3242250, pid=496)
```

You can inspect the raw SCTE-35 track directly over HTTP:

```bash
# raw SCTE-35 bytes as they arrive on the wire
curl -s http://localhost:4443/fetch/bbb.hang/0.ts | xxd
```

### Regional blackout

`--blackout-at N` (CSAI or SGAI) fires a one-shot **Program Blackout
Override** cue `N` seconds into the run, followed `--blackout-length` seconds
later (default `10`) by a restore cue. In CSAI this is the same
`segmentation_type_id: 0x18` descriptor as SGAI's Event Timeline record (section
7's "Regional blackout") — same delivery/blackout flags
(`no_regional_blackout_flag`/`web_delivery_allowed_flag`/`archive_allowed_flag`/`device_restrictions`)
and the same alternate-content URI carried as a `0x0F`-typed
`segmentation_upid` — but encoded as a real, CRC-valid `splice_info_section`
on the SCTE-35 PID (`csai/scte35.mjs`'s `buildProgramBlackoutOverrideSection`)
instead of published as JSON. There's no separate signaling broadcast to
subscribe to: a real affiliate headend already parsing the Break Start/End
track for splice points sees the same `0x18` type ID show up in-band and
switches to alternate content on the first cue, back to the normal feed on
the second.

```bash
./stream.sh bbb --csai-mode --blackout-at 20 --blackout-length 10
```

```
[CSAI] 2026-07-15T14:03:49.011Z Program Blackout Override -- ENFORCE (event_id=0x1388, pts=1802250, alt=moqt://localhost?ns=blackout-alt-content.hang, pid=496)
[CSAI] 2026-07-15T14:03:59.014Z Program Blackout Override -- RESTORE (event_id=0x1388, pts=2702475, pid=496)
```

### MoQ-native CSAI (architectural idea, not implemented)

Everything above still round-trips SCTE-35 through the same binary
`splice_info_section` encoding a legacy MPEG-TS/broadcast pipeline expects —
that's the point of CSAI (section 6's whole premise is decisioning happens
client-side, but the *signal* stays in the format an existing SCTE-35-aware
client already parses). A MoQ-native variant of CSAI is a different idea,
not built here: reuse SGAI's transport — the same `org.scte.scte35.v1` JSON
Event Timeline track, `@moq/msf` catalog, and Media Timeline
(section 7) — but leave the ad-break/blackout *decision* to the client
instead of an affiliate headend acting on it server-side. That would collapse
CSAI and SGAI into one signaling transport differing only in who
decides (client vs. server-guided), at the cost of losing CSAI's actual
purpose here: exercising the legacy binary SCTE-35 path end to end. Noted as
a possible future direction, not a gap in the current sandbox.

### A note on SCTE 35-2

Everything in this repo (CSAI's binary encoder, SGAI's `org.scte.scte35.v1`
JSON records) implements **SCTE 35-1** ("Legacy Splice-Based and Time-Based
Signaling", the April 2026 renumbering of the original SCTE-35). SCTE has
since published **SCTE 35-2** ("Event-Based Signaling"), a
`EventDescriptor`/PTP-based-`TimeDescriptor` model positioned as SCTE 35-1's
replacement rather than a companion spec. It isn't implemented here: the spec
sits behind SCTE's member paywall, so there's no bit-level definition to
conform to. Noted as a known gap, not a decision — worth revisiting if the
spec becomes accessible.

---

## 7. SGAI: Event Timeline signaling

`--ssai-mode` (section 5) *splices* the ad into the content's media stream —
server-side, one track. `--sgai-mode` is a different mode that instead
publishes content, ad, and ad-decisioning signaling as three **independent**
MoQ broadcasts: content plays unmodified and continuously, the ad is
published only on demand for the duration of each break, and a signaling
track carries `org.scte.scte35.v1`-shaped Event Timeline records for a
subscriber to act on — no server-side splicing, no MPEG-TS/SCTE-35 binary
encoding (contrast with CSAI, section 6): the records are already
decoded JSON.

This is the only mode with npm dependencies — declared in this repo's own
`package.json` (see "Project layout" above), even though only `sgai/*.mjs`
imports any of it today. Run `pnpm install` once before first use.

### What runs where

- **Inside Docker** (`run-stream.sh`, same container as always): content is
  published continuously to `<name>.hang` / `<name>.multi.hang`, exactly like
  the base pipeline. The ad is *not* published continuously — only the ad
  file is normalized to the content's profile and left on disk
  (`/tmp/ad_normalized.mp4`) for the Ad Decisioning Publisher below to
  trigger on demand.
- **On your host** (not in Docker): `sgai/ad-decisioning-publisher.mjs`
  connects to the relay as a third, independent MoQ publisher and emits
  `org.scte.scte35.v1`-shaped Event Timeline JSON records (built by
  `sgai/event-timeline.mjs`) on a broadcast named `<name>-events`, on a
  `--ad-break-every`-cadence schedule (ad break length is always the real
  duration of `assets/ad.mp4` — to test a different length, use a different
  ad file) — the ad-break schedule itself does not parse media timestamps
  (the Media Timeline below is a separate concern that does). The
  broadcast's `catalog` track is a real `@moq/msf` (draft-ietf-moq-msf-01)
  catalog with two tracks: `events` (`packaging: "eventtimeline"`) and
  `mediatime` (`packaging: "mediatimeline"`, see below) — not hand-rolled
  JSON. `events` declares `depends: ["mediatime"]`, a real co-published track.
  At the start of every ad break, this same script also `docker exec`s a
  fresh, single-shot `ffmpeg | moq import fmp4` of the normalized ad into the
  sandbox container, from the ad's own frame 0 — there is no
  continuously-looping ad stream to land mid-file on. Each ad break publishes
  under its own unique broadcast name (`<name>-ad-0.hang`, `<name>-ad-1.hang`,
  ...) rather than reusing one name across a kill+restart, since a relay may
  not clean up a killed producer's registration promptly enough for a
  same-named replacement to be routed to correctly. The name is carried to a
  subscriber in the record's `segmentation_upid_uri` field.
  `sgai/transport.mjs` holds the Node-specific relay connection workarounds
  (no native WebTransport, self-signed cert, `Promise.withResolvers` polyfill)
  shared by this script and the debug subscriber below.

The four records emitted per ad break, in order: `Ad Start` (carries the
per-break ad broadcast name), `Placement Opportunity Start`, `Ad End`,
`Placement Opportunity End`. A real subscriber is expected to `UNSUBSCRIBE`
from content on `Placement Opportunity Start`, `FETCH` the ad broadcast named
in `Ad Start`, and `RESUBSCRIBE` to content on `Placement Opportunity End`.

### Media Timeline

`sgai/ad-decisioning-publisher.mjs` also subscribes to the content
broadcast's own video track — never affecting its playback — purely to
observe it, and publishes a real `mediatime` track (`packaging:
"mediatimeline"`, entries `[mediaTimeMs, [groupId, objectId], wallClockMs]`,
per draft-ietf-moq-msf's explicit-entry format). `groupId`/`objectId` are
read straight off the wire (the relay's own Group/object sequence numbers),
not derived or guessed; `mediaTimeMs` comes from parsing the real `tfdt` box
in each object's fMP4 fragment (`sgai/media-timeline.mjs`, sharing its box
parser with `ssai/impression-tracker.mjs` via `lib/fmp4.mjs`). One entry is
emitted per Group (i.e. per keyframe/GOP boundary), matching the spec's own
illustrative sampling cadence.

**Simplification**: this track lives on the events broadcast (co-published
alongside `events`), not on the Media Publisher's own broadcast as the
architecture slides show — this sandbox's content publish is `moq import
fmp4`, an off-the-shelf binary this repo doesn't control and can't attach an
extra track to directly.

### Regional blackout

`--blackout-at N` (SGAI only) fires a one-shot **Program Blackout Override**
record (`segmentation_type_id: "0x18"`) `N` seconds into the run, per the
SGAI-over-MOQ spec's regional-blackout example: `no_regional_blackout_flag:
false` plus a `segmentation_upid_uri` pointing at alternate content, followed
`--blackout-length` seconds later (default `10`) by a restore record
(`no_regional_blackout_flag: true`, same `segmentation_event_id`). Override
the alternate-content URI with `--blackout-alt-upid`. A real affiliate
headend is expected to switch to the alternate content on the first record
and back to the normal feed on the second.

```bash
./stream.sh bbb --sgai-mode --blackout-at 45 --blackout-length 15
```

### MOQ URL format

Every `segmentation_upid_uri` this repo builds (ad upids, blackout alt-content
upids, in both CSAI and SGAI) is a real `moqt://` URL built by
`lib/msf-uri.mjs`'s `buildUri()`/`parseUri()`, following the `ns=`/`t=` query
convention shown in the architecture slides (e.g.
`moqt://example.com/relay-app/relayID?ns=customerID/broadcastID&t=video`) —
e.g. `moqt://localhost?ns=bbb-ad-0.hang`. `ns=` carries the broadcast path;
`t=` (track) is included only when the target track is known in advance —
which it usually isn't for an ad broadcast, since `moq-cli` only assigns its
actual track name once it starts publishing. This convention is shown only as
an informal example in the slides (draft-ietf-moq-msf's own ABNF leaves the
query's internal structure unspecified), and is adapted here to this
sandbox's flat broadcast naming rather than the slides' hierarchical
customerID/broadcastID pair, which this sandbox has no equivalent of.
`sgai/debug-subscriber.mjs` parses any upid it receives back into
`{ endpoint, namespace, track }` and logs it (`-- ns=... t=...`).

### Ad personalization (`%token%` substitution)

`--personalized-ads` (SGAI only) templates each ad's `segmentation_upid_uri`
with a `%token%` placeholder in the query string (e.g.
`moqt://localhost?ns=bbb-ad-0.hang&tok=%token%`), per draft-ietf-moq-msf's
Variable Substitution mechanism: a subscriber resolves `%varname%`
placeholders **client-side**, from the fragment (`#...`) of the URI it
connected with — never from a query parameter — using whatever token its own
session carries (see the draft's own example:
`moqt://relay.example.com/live#namespace--name&token=XYZ789` resolves a
`%token%` field to `XYZ789`). `sgai/debug-subscriber.mjs` simulates that: a
fragment on its own `--url` (e.g. `--url "http://localhost:4443#token=XYZ789"`)
is parsed the same way and resolved against any record it receives
(`lib/msf-uri.mjs`). This is orthogonal to the per-break unique broadcast
naming above, which solves a different problem (safe reuse across
kill+restart, not personalization) — the two combine freely.

### Inspect it in isolation

No browser or player needed — three terminals:

```bash
# 1. Confirm the content and events broadcasts are announced (the ad broadcast only
#    appears once the first ad break actually starts, under its own per-break name --
#    see "What runs where" above)
curl http://localhost:4443/announced

# 2. Sanity-check the events catalog (a real @moq/msf catalog; two tracks,
#    "events" and "mediatime" -- see "Media Timeline" above)
curl -s http://localhost:4443/fetch/bbb-events/catalog | jq

# 3. Watch the Event Timeline and Media Timeline live, with simulated subscriber
#    actions. The #token=... fragment on --url is optional -- pass it to see
#    %token% resolution in action (see "Ad personalization" above; only does
#    anything with --personalized-ads).
# Note: http://, not https:// -- see the callout below.
node sgai/debug-subscriber.mjs \
  --url "http://localhost:4443#token=XYZ789" --events-broadcast bbb-events \
  --content-broadcast bbb.hang --ad-broadcast bbb-ad.hang
```

The subscriber script prints each SCTE-35 record (Placement Opportunity
Start/End, Ad Start/End, Program Blackout Override) and each Media Timeline
entry as they arrive, plus the action a real subscriber would take
(`UNSUBSCRIBE` content / `FETCH` ad / `RESUBSCRIBE` content / enforce or
restore a blackout) — logged only, no playback is actually driven.

**Why `http://...` and not `https://` for these two scripts:** Node has no
native WebTransport, so `@moq/net` (used by both `ad-decisioning-publisher.mjs`
and `debug-subscriber.mjs`) falls back to a WebSocket transport. The relay's
`web.http` listener (the same one serving `/announced` and `/fetch`) is
plain HTTP — TLS (`tls.generate` in `run-stream.sh`'s `relay.toml`) only
applies to its separate QUIC/WebTransport listener on the UDP side, which is
what the browser player uses. Passing `https://` here gets converted to
`wss://` and fails the TLS handshake against a plain-HTTP port ("wrong
version number"). This only affects the two Node scripts in `sgai/` — the
player's `moq.url` config in section 4 correctly uses `https://`.

**Current limitation**: this sandbox only covers the server/host delivery
side. A player that actually acts on this signaling — subscribing to the
events broadcast and switching between the content and ad tracks — is a
separate piece of work, not included here.

---

## 8. Relay HTTP API

The relay exposes a plain HTTP API on the same port (TCP) alongside the QUIC
stream (UDP). You can use it to inspect what is being served.

```bash
# List all active broadcasts
curl http://localhost:4443/announced

# Fetch the catalog for a single-rendition stream
curl -s http://localhost:4443/fetch/bbb.hang/catalog.json | jq

# Fetch the catalog for an --abr-ladder stream
curl -s http://localhost:4443/fetch/bbb.multi.hang/catalog.json | jq

# Fetch the SGAI events catalog (see section 7)
curl -s http://localhost:4443/fetch/bbb-events/catalog | jq
```

The `/announced` endpoint is also used by the container startup script to
know when the relay is ready before publishing starts.

---

## 9. Troubleshooting

**"Docker daemon is not running"**
Open Docker Desktop and wait for it to finish starting, then try again. You
can check it is ready with `docker info`.

**"Missing assets/\<name\>.mp4"**
The content file is not where the script expects it. Check that the file is
in `assets/` and that the name matches what you typed on the command line (no
`.mp4` extension in the command).

**"Ad normalization failed; falling back to content-only stream"**
The ad file (`assets/ad.mp4`) exists but `ffmpeg` could not transcode it.
Check that it is a valid MP4 file with at least one video and one audio
stream. Run `ffprobe assets/ad.mp4` locally to inspect it.

**The relay starts but the player does not connect**
Your browser blocks self-signed certificates on QUIC by default. Open
`https://localhost:4443` directly in the browser, accept the certificate
warning, then reload the player page.

**The stream freezes at the ad→content transition (SSAI)**
This can happen if the ad file has a very different frame rate or resolution
and the normalization step did not run successfully. Check the Docker logs for
`SSAI: normalizing ad...` and for any ffmpeg error messages.

**`--sgai-mode` fails with a module-not-found error**
Run `pnpm install` once — `sgai/*.mjs` depends on `@moq/net`, `@moq/msf`,
`ws`, and `zod`, declared in this repo's own `package.json`.

**Port already in use**
Another process is using port 4443. Pass a different port with `--port N`,
and update the player's `moq.url` to match.

**The first build takes too long**
`moq` and `moq-relay` are downloaded as prebuilt binaries, not compiled, so
this should only take a few seconds beyond the base image pull. If a build is
taking minutes, check your network connection to GitHub releases rather than
assuming a source compile is happening. Subsequent builds use the Docker
layer cache and are faster still. To force a fresh build: `docker rmi moq-lab`.

---

## Contributing

Bug reports, ideas, and pull requests are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) for how to set up the repo locally, coding
conventions, and what to include in a PR.

---

## Acknowledgments

This sandbox is built entirely on top of
[moq-dev/moq](https://github.com/moq-dev/moq) — the MoQ (Media over QUIC)
relay and publisher/subscriber CLI (`moq-relay`, `moq-cli`, downloaded as
prebuilt binaries in the [Dockerfile](Dockerfile)) and the JS libraries (`@moq/net`,
`@moq/msf`) `sgai/` depends on. moq-lab doesn't reimplement any of the
protocol itself; it wraps that project in a repeatable Docker sandbox and
adds the SSAI/CSAI/SGAI ad-insertion handling around it.

Versions are pinned deliberately, not left floating — both sides move fast
enough (weekly-ish point releases, occasional breaking changes) that an
unpinned `cargo install`/`npm install` can silently pick up different
behavior on a rebuild. Currently: `moq-cli`/`moq-relay` `0.9.5`/`0.14.5`
([Dockerfile](Dockerfile)), `@moq/net` `0.2.2`/`@moq/msf` `0.2.0`
([package.json](package.json)). Bump the Rust and JS sides together and
re-test rather than upgrading one at a time — see
[CONTRIBUTING.md](CONTRIBUTING.md).
