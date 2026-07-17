#!/usr/bin/env bash
# Usage: stream.sh [name] [--abr-ladder] [--port N] [--ssai-mode] [--ad-break-every N]
#                   [--csai-mode] [--ad-break-length N]
#                   [--sgai-mode]
#
# --ad-break-every N   Seconds of content between ad breaks (default: 30). Shared by
#                      --ssai-mode, --csai-mode, and --sgai-mode.
# --ad-break-length N  CSAI only: seconds between the Break Start and Break End SCTE-35
#                      cues (default: 6). No ad video is interleaved -- the client
#                      decides what to do with the cues.
# --sgai-mode          Server-Guided Ad Insertion: content and ad are published as
#                      independent MoQ broadcasts, and a host-side Node process
#                      publishes SCTE-35-shaped Event Timeline signaling on a third
#                      broadcast. See README.md section 7. The ad break's own length is
#                      always assets/ad.mp4's real duration (auto-detected via ffprobe,
#                      minus a small pipeline-latency margin) -- to test a different ad
#                      break length, use a different ad.mp4.
set -euo pipefail

# Yellow only when stderr is an actual terminal -- keeps piped/redirected output
# (logs, CI) free of escape codes.
warn() {
    if [ -t 2 ]; then
        printf '\033[33mWarning: %s\033[0m\n' "$1" >&2
    else
        printf 'Warning: %s\n' "$1" >&2
    fi
}

NAME="bbb"
ABR_LADDER=false
PORT=4443
SSAI=false
AD_BREAK_EVERY=30
CSAI=false
AD_BREAK_LENGTH=6
AD_BREAK_LENGTH_SET=false
SGAI=false

while [ $# -gt 0 ]; do
    case "$1" in
        --abr-ladder) ABR_LADDER=true; shift ;;
        --port) PORT="$2"; shift 2 ;;
        --ssai-mode) SSAI=true; shift ;;
        --ad-break-every) AD_BREAK_EVERY="$2"; shift 2 ;;
        --csai-mode) CSAI=true; shift ;;
        --ad-break-length) AD_BREAK_LENGTH="$2"; AD_BREAK_LENGTH_SET=true; shift 2 ;;
        --sgai-mode) SGAI=true; shift ;;
        *) NAME="$1"; shift ;;
    esac
done

MODES_ON=0
[ "$SSAI" = true ] && MODES_ON=$((MODES_ON + 1))
[ "$CSAI" = true ] && MODES_ON=$((MODES_ON + 1))
[ "$SGAI" = true ] && MODES_ON=$((MODES_ON + 1))
if [ "$MODES_ON" -gt 1 ]; then
    echo "--ssai-mode, --csai-mode, and --sgai-mode are mutually exclusive (different pipelines)." >&2
    exit 1
fi

# --ad-break-length only drives CSAI's Break Start/End cue spacing. SSAI and SGAI always
# use assets/ad.mp4's own real duration (see README.md section 7), so a value passed here
# would be silently discarded further down -- warn instead of doing that quietly.
if [ "$AD_BREAK_LENGTH_SET" = true ] && [ "$CSAI" != true ]; then
    warn "--ad-break-length only applies to --csai-mode; ignored here (SSAI/SGAI always use assets/ad.mp4's real duration)."
fi

# This whole project is self-contained -- MOQ_DIR is the only path this
# script needs to find everything else (assets, Dockerfile, the host-side
# SGAI publisher).
MOQ_DIR="$(cd "$(dirname "$0")" && pwd)"
INPUT="$MOQ_DIR/assets/$NAME.mp4"
AD_INPUT="$MOQ_DIR/assets/ad.mp4"

if [ ! -f "$INPUT" ]; then
    echo "Missing $INPUT. Put a test clip at assets/$NAME.mp4 and try again." >&2
    exit 1
fi

if [ "$SSAI" = true ] && [ ! -f "$AD_INPUT" ]; then
    warn "$AD_INPUT not found. SSAI disabled; streaming content only."
    SSAI=false
fi

if [ "$SGAI" = true ] && [ ! -f "$AD_INPUT" ]; then
    warn "$AD_INPUT not found. SGAI disabled; streaming content only."
    SGAI=false
fi

if [ "$SGAI" = true ]; then
    SGAI_AD_REAL_LENGTH=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$AD_INPUT")
    # ad-decisioning-publisher.mjs launches a fresh, single-shot ad publish exactly when
    # each ad break starts (see its --container-name/--ad-file), so the ad always plays
    # from its own frame 0 -- there's no continuously-looping ffmpeg process to drift out
    # of sync with. This margin only covers encode/publish/decode pipeline latency at the
    # tail end, so the AD_END signal doesn't arrive a beat after the ad's last frame
    # already landed (which would freeze on that last frame for a moment).
    # LC_NUMERIC=C: awk's output formatting otherwise follows the shell's locale (e.g. a
    # comma decimal separator under it_IT), which Node's Number() then fails to parse.
    SGAI_AD_BREAK_LENGTH=$(LC_NUMERIC=C awk -v d="$SGAI_AD_REAL_LENGTH" 'BEGIN { v = d - 0.5; if (v < 1) v = 1; print v }')
    echo "Ad break length: assets/ad.mp4 is ${SGAI_AD_REAL_LENGTH}s, using ${SGAI_AD_BREAK_LENGTH}s" >&2
fi

if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required to run the MoQ streaming sandbox. Install Docker Desktop and try again." >&2
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    echo "Docker daemon is not running. Start Docker Desktop and try again." >&2
    exit 1
fi

IMAGE="moq-lab"
CONTAINER_NAME="moq-lab-$$"

cleanup() { docker rm -f "$CONTAINER_NAME" 2>/dev/null || true; }
trap cleanup EXIT

echo "Building sandbox image (ffmpeg + moq)... first build compiles moq/moq-relay from source, can take a few minutes"
docker build -t "$IMAGE" "$MOQ_DIR"

if [ "$ABR_LADDER" = true ]; then
    BROADCAST="$NAME.multi.hang"
else
    BROADCAST="$NAME.hang"
fi
AD_BROADCAST="$NAME-ad.hang"
EVENTS_BROADCAST="$NAME-events"

DOCKER_VOLUMES=(-v "$INPUT:/media/input.mp4:ro")
if [ "$SSAI" = true ] || [ "$SGAI" = true ]; then
    DOCKER_VOLUMES+=(-v "$AD_INPUT:/media/ad.mp4:ro")
fi

if [ "$SGAI" = true ]; then
    docker run --name "$CONTAINER_NAME" --rm -d --init \
        "${DOCKER_VOLUMES[@]}" \
        -p "$PORT:$PORT/udp" -p "$PORT:$PORT/tcp" \
        "$IMAGE" /media/input.mp4 "$BROADCAST" "$ABR_LADDER" "$PORT" "$SSAI" "$AD_BREAK_EVERY" "$CSAI" "$AD_BREAK_LENGTH" "$SGAI" "$AD_BROADCAST" \
        >/dev/null
    CONTAINER_LOG="/tmp/moq-lab-$$.log"
    docker logs -f "$CONTAINER_NAME" > >(tee "$CONTAINER_LOG" >&2) 2>&1 &
    LOGS_PID=$!
    trap 'kill "$LOGS_PID" 2>/dev/null || true; rm -f "$CONTAINER_LOG"; cleanup' EXIT

    echo "Waiting for relay HTTP API on the host..." >&2
    until curl -sf "http://localhost:${PORT}/announced" > /dev/null 2>&1; do
        sleep 0.5
    done

    # Relay being reachable isn't a reliable proxy for "the normalized ad file is ready" -- ad
    # normalization and container startup take a variable amount of time. The Ad Decisioning
    # Publisher launches its own fresh ad publish process (via `docker exec`) inside the
    # container at the start of each ad break, so the normalized file must exist first. Wait
    # for run-stream.sh's own marker (tee'd into $CONTAINER_LOG above) rather than guessing.
    echo "Waiting for the ad file to be ready..." >&2
    until grep -q "SGAI: ad file ready" "$CONTAINER_LOG" 2>/dev/null; do
        sleep 0.1
    done

    echo "Relay ready. Starting Ad Decisioning Publisher (events broadcast: $EVENTS_BROADCAST)..." >&2
    # Note: http:// (not https://) — the relay's web.http listener that speaks
    # WebSocket/qmux is plain HTTP; TLS only applies to its native QUIC/WebTransport
    # listener, which Node can't use (no WebTransport support). See README section 7.
    node "$MOQ_DIR/sgai/ad-decisioning-publisher.mjs" \
        --url "http://localhost:${PORT}" \
        --content-broadcast "$BROADCAST" \
        --ad-broadcast "$AD_BROADCAST" \
        --events-broadcast "$EVENTS_BROADCAST" \
        --ad-break-every "$AD_BREAK_EVERY" \
        --ad-break-length "$SGAI_AD_BREAK_LENGTH" \
        --container-name "$CONTAINER_NAME" \
        --relay-port "$PORT" \
        --ad-file "/tmp/ad_normalized.mp4"
else
    docker run --name "$CONTAINER_NAME" --rm -it --init \
        "${DOCKER_VOLUMES[@]}" \
        -p "$PORT:$PORT/udp" -p "$PORT:$PORT/tcp" \
        "$IMAGE" /media/input.mp4 "$BROADCAST" "$ABR_LADDER" "$PORT" "$SSAI" "$AD_BREAK_EVERY" "$CSAI" "$AD_BREAK_LENGTH"
fi
