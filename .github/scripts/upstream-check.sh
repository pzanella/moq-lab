#!/usr/bin/env bash
# Compares the pinned MoQ versions with the newest upstream releases and writes a
# Markdown report to stdout. Exits 0 when everything is up to date, 1 when at
# least one pin is behind. Used by .github/workflows/upstream-check.yml; you can
# also run it locally (needs `gh` and `npm`).
set -euo pipefail

cd "$(dirname "$0")/../.."

containerfile_arg() {
    sed -n "s/^ARG $1=//p" Containerfile
}

package_version() {
    node -e "const p = require('./$1'); console.log(p.dependencies['$2'])"
}

# moq-dev/moq tags every crate in one repo (moq-relay-v0.17.8, moq-cli-v0.14.8, ...),
# so take the newest non-prerelease tag with the crate's prefix.
latest_release() {
    gh release list -R moq-dev/moq -L 200 --exclude-pre-releases --json tagName --jq '.[].tagName' |
        sed -n "s/^$1-v//p" | sort -V | tail -1
}

rows=()
behind=0
check() {
    local name="$1" pinned="$2" latest="$3" where="$4"
    local status="up to date"
    if [ "$pinned" != "$latest" ]; then
        status="**update available**"
        behind=1
    fi
    rows+=("| \`$name\` | $pinned | $latest | $status | $where |")
}

check moq-relay "$(containerfile_arg MOQ_RELAY_VERSION)" "$(latest_release moq-relay)" "Containerfile, ci.yml"
check moq-cli "$(containerfile_arg MOQ_CLI_VERSION)" "$(latest_release moq-cli)" "Containerfile"
check @moq/net "$(package_version package.json @moq/net)" "$(npm view @moq/net version)" "package.json"
check @moq/net "$(package_version dashboard/package.json @moq/net)" "$(npm view @moq/net version)" "dashboard/package.json"
check @moq/msf "$(package_version package.json @moq/msf)" "$(npm view @moq/msf version)" "package.json"

cat <<EOF
This report is updated every week by \`.github/workflows/upstream-check.yml\`.

| Component | Pinned | Latest | Status | Where |
|---|---|---|---|---|
$(printf '%s\n' "${rows[@]}")

Update the Rust and JS sides together, run all smoke tests, and add a
CHANGELOG.md entry. See CONTRIBUTING.md, "Bump pinned versions together".
EOF

exit "$behind"
