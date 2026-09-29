#!/usr/bin/env bash
# Deploy one site release on the server. Run by .github/workflows/website.yml
# after it uploads serve.ts, Dockerfile, compose.yaml, deploy.sh and public/
# to $BASE/releases/$GIT_SHA/.
#
#   GIT_SHA=<40 hex> SITE_HOST=yon.meo.in.th bash deploy.sh
#
# Marks the release current only after the local checks (health, phone page
# CSP) and the public hostname checks pass; otherwise switches back to the
# last good image and exits 1.
set -Eeuo pipefail

BASE="${YON_SITE_BASE:-/opt/yon-site}" # ponytail: override only for tests
GIT_SHA="${GIT_SHA:-}"
SITE_HOST="${SITE_HOST:-}"

case "$GIT_SHA" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) echo "Invalid Git SHA"; exit 1 ;;
esac
# WHY: it ends up in a URL passed to curl; host names only.
if ! printf '%s' "$SITE_HOST" | grep -Eq '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$'; then
  echo "Invalid SITE_HOST"; exit 1
fi

cd "$BASE/releases/$GIT_SHA"
[ -f public/index.html ] && [ -f public/phonelink/index.html ] || { echo "Release has no public/ site"; exit 1; }
CURRENT_SHA="$(cat "$BASE/current.tag" 2>/dev/null || true)"
ok=0

rollback() {
  [ "$ok" = 1 ] && return
  echo "Deploy of $GIT_SHA failed"
  # current.tag still names the last good release (it moves only on success).
  if [ -n "$CURRENT_SHA" ] && docker image inspect "yon-site:$CURRENT_SHA" >/dev/null 2>&1; then
    echo "Rolling back to $CURRENT_SHA"
    YON_SITE_TAG="$CURRENT_SHA" docker compose -f compose.yaml up -d --no-build
  else
    echo "No previous release to roll back to; yon-site:$GIT_SHA left for debugging"
  fi
}
trap rollback EXIT

docker build \
  --label "org.opencontainers.image.title=yon-site" \
  --label "org.opencontainers.image.revision=$GIT_SHA" \
  --tag "yon-site:$GIT_SHA" \
  .

YON_SITE_TAG="$GIT_SHA" docker compose -f compose.yaml up -d --no-build

# WHY: poll instead of a fixed sleep — the container needs a moment to start,
# and a fixed wait either wastes time or is too short on a busy host.
status=""
for _ in $(seq 1 15); do
  status="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/healthz || true)"
  [ "$status" = 200 ] && break
  sleep 1
done
[ "$status" = 200 ] || { echo "Local health check failed (HTTP $status)"; exit 1; }
echo "Local site is healthy"

# The phone page holds the pairing key: it must be served with its CSP header.
headers="$(curl -sS -D - -o /dev/null http://127.0.0.1:8788/phonelink/)"
printf '%s' "$headers" | head -n 1 | grep -q ' 200' || { echo "Local /phonelink/ is not 200"; exit 1; }
if ! printf '%s' "$headers" | grep -iq '^content-security-policy:.*connect-src wss:'; then
  echo "Local /phonelink/ has no Content-Security-Policy with connect-src wss:"; exit 1
fi
echo "Local /phonelink/ has its CSP"

# WHY: retries — the tunnel may take a moment to reach the new container.
for path in / /phonelink/; do
  echo "Public check: https://$SITE_HOST$path"
  curl -fsS -o /dev/null --retry 10 --retry-delay 3 --retry-all-errors --max-time 10 \
    "https://$SITE_HOST$path"
done

# All checks passed: this release is now current.
if [ -n "$CURRENT_SHA" ] && [ "$CURRENT_SHA" != "$GIT_SHA" ]; then
  # WHY: previous moves only on success, so a failed deploy can't push the
  # last good-but-one release out of the keep list below.
  docker tag "yon-site:$CURRENT_SHA" yon-site:previous
  printf '%s\n' "$CURRENT_SHA" > "$BASE/previous.tag"
fi
docker tag "yon-site:$GIT_SHA" yon-site:current
printf '%s\n' "$GIT_SHA" > "$BASE/current.tag"
ok=1
echo "Deployed yon-site:$GIT_SHA"

# Cleanup: only the yon-site repository and $BASE/releases. Every removal is
# printed first. Keeps current, previous and their SHA tags.
PREVIOUS_SHA="$(cat "$BASE/previous.tag" 2>/dev/null || true)"
keep() { case "$1" in current | previous | "$GIT_SHA" | "$PREVIOUS_SHA") return 0 ;; esac; return 1; }
docker image ls yon-site --format '{{.Tag}}' | while read -r tag; do
  keep "$tag" && continue
  echo "Removing image yon-site:$tag"
  docker image rm "yon-site:$tag" || echo "Could not remove yon-site:$tag"
done
for dir in "$BASE"/releases/*/; do
  name="$(basename "$dir")"
  keep "$name" && continue
  echo "Removing release directory $BASE/releases/$name"
  rm -rf -- "$BASE/releases/$name"
done
