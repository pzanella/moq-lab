#!/usr/bin/env bash
set -euo pipefail

# Yellow only when stderr is an actual terminal -- keeps piped/redirected output
# (docker logs, CI) free of escape codes.
warn() {
    if [ -t 2 ]; then
        printf '\033[33mWarning: %s\033[0m\n' "$1" >&2
    else
        printf 'Warning: %s\n' "$1" >&2
    fi
}

INPUT="$1"
BROADCAST="$2"
ABR_LADDER="$3"
PORT="$4"
SSAI="${5:-false}"
AD_BREAK_EVERY="${6:-30}"
CSAI="${7:-false}"
AD_BREAK_LENGTH="${8:-6}"
SGAI="${9:-false}"
AD_BROADCAST="${10:-}"
AD="/media/ad.mp4"

# Shared 5-rendition x264 ladder (240p/360p/480p/720p/1080p): reused as-is by
# the base pipeline, CSAI, and SSAI. Only the -map/-force_key_frames around it
# differ per mode, so those are added at each call site.
ABR_LADDER_FILTER_COMPLEX="[0:v]split=5[v0][v1][v2][v3][v4];[v0]scale=-2:240[v240];[v1]scale=-2:360[v360];[v2]scale=-2:480[v480];[v3]scale=-2:720[v720];[v4]scale=-2:1080[v1080]"
ABR_LADDER_ENCODE_ARGS=(
    -preset veryfast -g 50 -keyint_min 50 -sc_threshold 0
    -c:v:0 libx264 -profile:v:0 high -level:v:0 3.0 -pix_fmt:v:0 yuv420p -b:v:0 400k
    -c:v:1 libx264 -profile:v:1 high -level:v:1 3.1 -pix_fmt:v:1 yuv420p -b:v:1 800k
    -c:v:2 libx264 -profile:v:2 high -level:v:2 3.1 -pix_fmt:v:2 yuv420p -b:v:2 1500k
    -c:v:3 libx264 -profile:v:3 high -level:v:3 4.1 -pix_fmt:v:3 yuv420p -b:v:3 4M
    -c:v:4 libx264 -profile:v:4 high -level:v:4 4.1 -pix_fmt:v:4 yuv420p -b:v:4 8M
    -c:a aac -profile:a aac_low -b:a 128k
)

# CSAI (client-side ad insertion signaling) publishes an extra SCTE-35 track
# alongside the same continuous content stream -- no ad video is interleaved,
# the client decides what to do with the Break Start/End cues. This is a
# separate pipeline from SSAI (which interleaves real ad video server-side)
# and from the base fmp4 stream below, so it's handled entirely on its own
# before either of those, leaving both untouched.
if [ "$CSAI" = true ]; then
    echo "Starting relay on https://localhost:$PORT (broadcast=$BROADCAST, abr-ladder=$ABR_LADDER, csai=true, ad-break-every=$AD_BREAK_EVERY, ad-break-length=$AD_BREAK_LENGTH)" >&2

    cat > /tmp/relay.toml <<EOF
[server]
listen = "[::]:${PORT}"
tls.generate = ["localhost"]

[web.http]
listen = "[::]:${PORT}"

[auth]
public = ""
EOF

    moq-relay /tmp/relay.toml &
    RELAY_PID=$!

    cleanup() { kill "$RELAY_PID" 2>/dev/null || true; }
    trap cleanup EXIT
    trap 'cleanup; exit 0' INT TERM

    echo "Waiting for relay HTTP API..." >&2
    until curl -sf "http://localhost:${PORT}/announced" > /dev/null 2>&1; do
        sleep 0.5
    done
    echo "Relay ready. Streaming '$BROADCAST' with a Break Start/End SCTE-35 track." >&2

    # Same rendition ladder as the base (non-ad) stream below, just muxed to
    # MPEG-TS instead of fmp4 so ts-injector.mjs can add the SCTE-35 PID.
    if [ "$ABR_LADDER" = true ]; then
        CSAI_FFMPEG_ARGS=(
            -filter_complex "$ABR_LADDER_FILTER_COMPLEX"
            -map "[v240]" -map "[v360]" -map "[v480]" -map "[v720]" -map "[v1080]" -map 0:a:0
            "${ABR_LADDER_ENCODE_ARGS[@]}"
        )
    else
        CSAI_FFMPEG_ARGS=(-c copy)
    fi

    ffmpeg -hide_banner -v quiet -stream_loop -1 -re -i "$INPUT" \
        "${CSAI_FFMPEG_ARGS[@]}" \
        -f mpegts - |
        node /usr/local/bin/csai/ts-injector.mjs "$AD_BREAK_EVERY" "$AD_BREAK_LENGTH" |
        moq --client-connect "http://localhost:${PORT}" --broadcast "$BROADCAST" import ts

    exit 0
fi

if [ "$SSAI" = true ] && [ ! -f "$AD" ]; then
    warn "$AD not found inside container. Falling back to content-only stream."
    SSAI=false
fi

if [ "$SGAI" = true ] && [ ! -f "$AD" ]; then
    warn "$AD not found inside container. Falling back to content-only stream."
    SGAI=false
fi

# Re-encode the ad to match the content's resolution, frame rate, and sample rate.
# The concat filter breaks if the inputs have different formats. Run in background to hide the cost.
NORM_AD=/tmp/ad_normalized.mp4
PREP_PID=""
if [ "$SSAI" = true ] || [ "$SGAI" = true ]; then
    V_SIZE=$(ffprobe -v error -select_streams v:0 \
        -show_entries stream=width,height -of csv=s=x:p=0 "$INPUT")
    V_FPS=$(ffprobe -v error -select_streams v:0 \
        -show_entries stream=avg_frame_rate -of csv=p=0 "$INPUT")
    A_RATE=$(ffprobe -v error -select_streams a:0 \
        -show_entries stream=sample_rate -of csv=p=0 "$INPUT")
    A_CH=$(ffprobe -v error -select_streams a:0 \
        -show_entries stream=channels -of csv=p=0 "$INPUT")

    echo "SSAI: normalizing ad to content profile (${V_SIZE} @ ${V_FPS} fps, ${A_RATE} Hz ${A_CH}ch)..." >&2
    ffmpeg -hide_banner -v quiet \
        -i "$AD" \
        -vf "scale=${V_SIZE/x/:},fps=${V_FPS}" \
        -c:v libx264 -preset ultrafast -g 50 -keyint_min 25 -sc_threshold 0 -pix_fmt yuv420p \
        -ar "$A_RATE" -ac "$A_CH" -c:a aac -profile:a aac_low -b:a 128k \
        "$NORM_AD" &
    PREP_PID=$!
fi

echo "Starting relay on https://localhost:$PORT (broadcast=$BROADCAST, abr-ladder=$ABR_LADDER, ssai=$SSAI, sgai=$SGAI)" >&2

cat > /tmp/relay.toml <<EOF
[server]
listen = "[::]:${PORT}"
tls.generate = ["localhost"]

[web.http]
listen = "[::]:${PORT}"

[auth]
public = ""
EOF

moq-relay /tmp/relay.toml &
RELAY_PID=$!

cleanup() {
    kill "$RELAY_PID" 2>/dev/null || true
    [ -n "$PREP_PID" ] && kill "$PREP_PID" 2>/dev/null || true
}
trap cleanup EXIT
trap 'cleanup; exit 0' INT TERM

echo "Waiting for relay HTTP API..." >&2
until curl -sf "http://localhost:${PORT}/announced" > /dev/null 2>&1; do
    sleep 0.5
done
echo "Relay ready. Streaming '$BROADCAST'." >&2

if { [ "$SSAI" = true ] || [ "$SGAI" = true ]; } && [ -n "$PREP_PID" ]; then
    if ! wait "$PREP_PID"; then
        echo "Ad normalization failed; falling back to content-only stream." >&2
        SSAI=false
        SGAI=false
    fi
    PREP_PID=""
    # Marker for the host-side script: the Ad Decisioning Publisher launches a fresh ad
    # publish (via `docker exec`) at the start of each ad break, referencing this file, so it
    # must exist first.
    [ "$SGAI" = true ] && echo "SGAI: ad file ready" >&2
fi

# Publishes the (looped) content video as a single MoQ broadcast. Shared by the
# plain path and SGAI mode, where content is published unspliced alongside a
# separately-published ad broadcast.
publish_content() {
    local broadcast="$1"

    if [ "$ABR_LADDER" = true ]; then
        FFMPEG_ARGS=(
            -filter_complex "$ABR_LADDER_FILTER_COMPLEX"
            -map "[v240]" -map "[v360]" -map "[v480]" -map "[v720]" -map "[v1080]" -map 0:a:0
            "${ABR_LADDER_ENCODE_ARGS[@]}"
        )
    else
        FFMPEG_ARGS=(-c copy)
    fi

    ffmpeg -hide_banner -v quiet -stream_loop -1 -re -i "$INPUT" \
        "${FFMPEG_ARGS[@]}" \
        -f mp4 -movflags cmaf+separate_moof+delay_moov+skip_trailer+frag_every_frame - |
        moq --client-connect "http://localhost:${PORT}" --broadcast "$broadcast" import fmp4
}

if [ "$SSAI" = true ]; then
    CONTENT_DUR=$(ffprobe -v error -show_entries format=duration \
        -of default=noprint_wrappers=1:nokey=1 "$INPUT" | awk '{print int($1)}')
    SEGS_PER_PASS=$(( (CONTENT_DUR + AD_BREAK_EVERY - 1) / AD_BREAK_EVERY ))
    [ "$SEGS_PER_PASS" -lt 1 ] && SEGS_PER_PASS=1

    # Cap at 20 cycles per pass. Each ffmpeg input uses ~10 MB of decoder memory.
    # The while loop keeps the stream running across passes.
    N_CYCLES="$SEGS_PER_PASS"
    [ "$N_CYCLES" -gt 20 ] && N_CYCLES=20

    echo "SSAI: ${N_CYCLES} cycles per pass (content ${CONTENT_DUR}s, ad every ${AD_BREAK_EVERY}s, restart loop active)." >&2

    # SSAI has no --ad-break-length flag (unlike CSAI) -- the break's length is always the
    # normalized ad's own duration, so this overwrites the unused CSAI-only default from $8.
    AD_BREAK_LENGTH=$(ffprobe -v error -show_entries format=duration \
        -of default=noprint_wrappers=1:nokey=1 "$NORM_AD")
    CYCLE_DUR=$(awk "BEGIN{printf \"%.6f\", ${AD_BREAK_EVERY} + ${AD_BREAK_LENGTH}}")

    # Force a keyframe at every ad→content boundary so moq can start the new segment immediately.
    FORCE_KEY_TIMES=""
    for ((cycle=0; cycle<N_CYCLES; cycle++)); do
        T=$(awk "BEGIN{printf \"%.3f\", ${cycle} * ${CYCLE_DUR} + ${AD_BREAK_EVERY}}")
        FORCE_KEY_TIMES="${FORCE_KEY_TIMES:+${FORCE_KEY_TIMES},}${T}"
    done

    # Build inputs and filter graph dynamically. Each cycle gets two inputs:
    # a content segment and the normalized ad.
    #
    # realtime/arealtime go per-input so each segment throttles independently.
    # A single post-concat realtime would stall across all future inputs, causing long pauses.
    #
    # -filter_complex_script avoids hitting the shell command-line length limit.
    INPUT_ARGS=()
    FC_SCRIPT=/tmp/ssai_fc.txt
    CONCAT_PADS=""

    for ((cycle=0; cycle<N_CYCLES; cycle++)); do
        SEG_START=$(( (cycle % SEGS_PER_PASS) * AD_BREAK_EVERY ))
        C_IDX=$(( cycle * 2 ))
        A_IDX=$(( C_IDX + 1 ))
        INPUT_ARGS+=(-thread_queue_size 8 -ss "$SEG_START" -t "$AD_BREAK_EVERY" -i "$INPUT")
        INPUT_ARGS+=(-thread_queue_size 8 -i "$NORM_AD")
        CONCAT_PADS+="[vc${cycle}][ac${cycle}][va${cycle}][aa${cycle}]"
    done

    {
        for ((cycle=0; cycle<N_CYCLES; cycle++)); do
            C_IDX=$(( cycle * 2 ))
            A_IDX=$(( C_IDX + 1 ))
            printf "[%d:v]realtime,setpts=PTS-STARTPTS[vc%d];[%d:a]arealtime,asetpts=PTS-STARTPTS[ac%d];\n" \
                "$C_IDX" "$cycle" "$C_IDX" "$cycle"
            printf "[%d:v]realtime,setpts=PTS-STARTPTS[va%d];[%d:a]arealtime,asetpts=PTS-STARTPTS[aa%d];\n" \
                "$A_IDX" "$cycle" "$A_IDX" "$cycle"
        done

        if [ "$ABR_LADDER" = true ]; then
            printf "%sconcat=n=%d:v=1:a=1[vcat][acat];\n" \
                "$CONCAT_PADS" "$(( N_CYCLES * 2 ))"
            printf "[vcat]split=5[vs0][vs1][vs2][vs3][vs4];\n"
            printf "[vs0]scale=-2:240[v240];[vs1]scale=-2:360[v360];\n"
            printf "[vs2]scale=-2:480[v480];[vs3]scale=-2:720[v720];[vs4]scale=-2:1080[v1080]\n"
        else
            printf "%sconcat=n=%d:v=1:a=1[vout][aout]\n" \
                "$CONCAT_PADS" "$(( N_CYCLES * 2 ))"
        fi
    } > "$FC_SCRIPT"

    if [ "$ABR_LADDER" = true ]; then
        ENCODE_ARGS=(
            -map "[v240]" -map "[v360]" -map "[v480]" -map "[v720]" -map "[v1080]" -map "[acat]"
            -force_key_frames "${FORCE_KEY_TIMES}"
            "${ABR_LADDER_ENCODE_ARGS[@]}"
        )
    else
        ENCODE_ARGS=(
            -map "[vout]" -map "[aout]"
            -c:v libx264 -preset veryfast -g 50 -keyint_min 50 -sc_threshold 0
            -force_key_frames "${FORCE_KEY_TIMES}" -pix_fmt yuv420p
            -c:a aac -profile:a aac_low -b:a 128k
        )
    fi

    while true; do
        ffmpeg -hide_banner -v quiet \
            "${INPUT_ARGS[@]}" \
            -filter_complex_script "$FC_SCRIPT" \
            "${ENCODE_ARGS[@]}" \
            -f mp4 -movflags cmaf+separate_moof+delay_moov+skip_trailer+frag_every_frame - |
            node /usr/local/bin/ssai/impression-tracker.mjs "$AD_BREAK_EVERY" "$AD_BREAK_LENGTH" |
            moq --client-connect "http://localhost:${PORT}" --broadcast "$BROADCAST" import fmp4 || true
        echo "SSAI: pass complete, restarting..." >&2
    done
elif [ "$SGAI" = true ]; then
    # SGAI mode: content and ad are two fully independent MoQ broadcasts (no
    # splicing). Ad-break signaling, and the ad publish itself, are driven
    # out-of-process by sgai/ad-decisioning-publisher.mjs on the
    # host: it `docker exec`s a fresh, single-shot publish of $NORM_AD into this
    # container at the start of each ad break, so the ad always starts at its own
    # frame 0 instead of wherever a continuously-looping stream happened to be.
    echo "SGAI: publishing content ('$BROADCAST') only; ad ('$AD_BROADCAST') is published on-demand per ad break." >&2

    publish_content "$BROADCAST"
else
    publish_content "$BROADCAST"
fi
