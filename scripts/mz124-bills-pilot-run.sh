#!/usr/bin/env bash
# Local only. Requires already installed dependencies, Chromium, and PostgreSQL.
set -euo pipefail
test "$#" -eq 2 || { echo "usage: bash $0 <source-checkout> <tracked-git-revision>" >&2; exit 2; }
SRC=$(cd "$1" && pwd -P); REV=$(git -C "$SRC" rev-parse --verify "$2^{commit}")
S=$(cd "$(dirname "$0")" && pwd -P)
for c in initdb pg_ctl createdb psql openssl node lsof curl; do command -v "$c" >/dev/null; done
for port in 43171 43172 43173; do
 if lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null; then echo 'Pilot ports already used; nothing stopped' >&2; exit 2; fi
done
T=$(mktemp -d /tmp/mz124-bills.XXXXXX)
echo "Output: $T; source revision: $REV"
umask 077
mkdir "$T/socket"
git -C "$SRC" archive "$REV" frontend backend | tar -x -C "$T"
for part in frontend backend; do
 cmp -s "$SRC/$part/package-lock.json" "$T/$part/package-lock.json" || { echo "Dependency lock differs in $part" >&2; exit 2; }
 node -e 'const a=require(process.argv[1]),b=require(process.argv[2]); for(const k of ["dependencies","devDependencies","optionalDependencies","peerDependencies","engines"]) require("node:assert/strict").deepEqual(a[k],b[k],k)' "$SRC/$part/package.json" "$T/$part/package.json"
 test -d "$SRC/$part/node_modules"
 ln -s "$SRC/$part/node_modules" "$T/$part/node_modules"
done
printf '%s\n' "$REV" > "$T/source-revision"
cleanup(){
 test -z "${WEB_PID:-}" || kill "$WEB_PID" 2>/dev/null || :
 test -z "${API_PID:-}" || kill "$API_PID" 2>/dev/null || :
 test ! -f "$T/pg/postmaster.pid" || pg_ctl -D "$T/pg" -m fast -w stop >/dev/null 2>&1 || :
}
trap cleanup EXIT
initdb --auth=trust --no-locale -E UTF8 -D "$T/pg" > "$T/pg-init.log" 2>&1
pg_ctl -D "$T/pg" -l "$T/pg.log" -o "-h 127.0.0.1 -p 43173 -k $T/socket" -w start
createdb -h "$T/socket" -p 43173 mz124_bills_pilot
psql -X -h "$T/socket" -p 43173 -d mz124_bills_pilot -f "$S/mz124-bills-pilot-fixture.sql"
KEY=$(openssl rand -hex 32)
(
 cd "$T"
 exec env -i PATH="$PATH" HOME="$HOME" NODE_ENV=test MZ124_PILOT_KEY="$KEY" DATABASE_URL="postgresql://$(id -un)@127.0.0.1:43173/mz124_bills_pilot?sslmode=disable" node "$S/mz124-bills-pilot-local.cjs" "$T/backend"
) > "$T/api.log" 2>&1 & API_PID=$!
(
 cd -P "$T/frontend"
 exec env -i PATH="$PATH" HOME="$HOME" WATCHPACK_POLLING=1000 NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:43172 node "$PWD/node_modules/next/dist/bin/next" dev "$PWD" -H 127.0.0.1 -p 43171
) > "$T/web.log" 2>&1 & WEB_PID=$!
for i in $(seq 1 50); do
 kill -0 "$API_PID" && kill -0 "$WEB_PID" || exit 2
 if curl -fsS http://127.0.0.1:43172/health > /dev/null 2>&1 && grep -q 'Ready in' "$T/web.log"; then break; fi
 sleep 1
done
B=(env -i "PATH=$PATH" "HOME=$HOME" "MZ124_PILOT_KEY=$KEY")
# First prove a wrong expectation causes failure; it stops before writes.
set +e
"${B[@]}" MZ124_PILOT_NEGATIVE=history node "$S/mz124-bills-pilot-browser.cjs" "$T/frontend" "$T/backend" "$T/negative" > "$T/negative.log" 2>&1
negative_status=$?
set -e
test "$negative_status" -eq 1 && grep -q '历史账单对照不成立' "$T/negative.log" && test ! -e "$T/negative/result.json" || { echo "Negative probe did not fail at the intended assertion"; exit 1; }
"${B[@]}" node "$S/mz124-bills-pilot-browser.cjs" "$T/frontend" "$T/backend" "$T/artifacts" | tee "$T/browser.log"
node "$S/mz124-bills-pilot-gate.cjs" "$T/artifacts/result.json" "${MZ124_APPROVED_BASELINE:-}"
