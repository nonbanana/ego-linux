#!/bin/sh
# Linux stand-in for the `ego-browser` command that Ego Lite installs on macOS.
# Runs the SDK built from this checkout against a local Chrome or Chromium.
set -eu

usage() {
	echo "usage: ego-browser nodejs [--sdk-path PATH] [-e CODE] < script.js" >&2
	exit 2
}

[ "${1:-}" = "nodejs" ] || usage
shift

sdk="$(dirname "$(readlink -f "$0")")/../dist/out/index.js"
code=""
has_code=""
while [ $# -gt 0 ]; do
	case "$1" in
	--sdk-path)
		[ $# -ge 2 ] || usage
		sdk="$2"
		shift 2
		;;
	-e)
		[ $# -ge 2 ] || usage
		code="$2"
		has_code=1
		shift 2
		;;
	*)
		echo "ego-browser nodejs: unknown option $1" >&2
		usage
		;;
	esac
done

[ -f "$sdk" ] || {
	echo "ego-browser: SDK not found at $sdk (run npm run build in package/ego-browser)" >&2
	exit 1
}

if [ -n "$has_code" ]; then
	printf '%s\n' "$code" | node "$sdk"
	exit
fi
exec node "$sdk"
