#!/bin/sh
# Fails when a banned word appears in the public text: README.md, docs, src, tests,
# scripts, render.yaml, policy.example.json or .env.example.
# This script file is excluded because it must name the banned words to search for them.
set -u
cd "$(dirname "$0")/.."
# Word list built in pieces so this file is not a hit when scanned elsewhere.
w1="au""dit"
w2="pro""fit"
w3="guarantee[ds]?"
w4="launch""ed"
w5="li""ve"
pattern="$w1|$w2|$w3|$w4|$w5"
paths="README.md src tests scripts render.yaml policy.example.json .env.example"
[ -d docs ] && paths="$paths docs"
# shellcheck disable=SC2086
hits=$(grep -rniwE "$pattern" $paths --exclude='banned-words.sh' || true)
if [ -n "$hits" ]; then
  echo "$hits"
  echo "banned words found"
  exit 1
fi
echo "banned words: none"
