#!/bin/sh
# Fails when a tracked file looks like something that must never be public:
# env or key files, a private key block, a PayPal token or client secret, or
# an email address other than support@elghaly.dev and the reserved example
# domains. Private terms (names, places) are read from PUBLIC_SAFETY_TERMS
# or the untracked file .public-safety.local, one per line, so they are never
# written into this repo. Hits are printed as file:line only, never the text.
set -u
cd "$(dirname "$0")/.."
fail=0
self=':(exclude)scripts/public-safety.sh'

names=$(git ls-files | grep -iE '(^|/)(\.env(\..+)?|[^/]*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)|config\.toml|[^/]*(keypair|wallet|secret)[^/]*\.json)$' | grep -vx '\.env\.example' || true)
if [ -n "$names" ]; then
  echo "files that must not be tracked:"
  echo "$names"
  fail=1
fi

secret='BEGIN [A-Z ]*PRIVATE KEY|A21AA[A-Za-z0-9_-]{30,}|PAYPAL_CLIENT_(ID|SECRET)=["'"'"']?[A-Za-z0-9_-]{10,}|client_secret["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9_-]{20,}'
hits=$(git grep -nIE "$secret" -- . "$self" | cut -d: -f1,2 || true)
if [ -n "$hits" ]; then
  echo "lines that look like a key, token or secret:"
  echo "$hits"
  fail=1
fi

emails=$(git grep -hnoIE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' -- . "$self" ':(exclude)package-lock.json' \
  | cut -d: -f2- | sort -u \
  | grep -viE '^support@elghaly\.dev$|@([a-z0-9-]+\.)*example(\.(com|net|org))?$|@([a-z0-9-]+\.)*(test|invalid)$' || true)
if [ -n "$emails" ]; then
  echo "email addresses other than support@elghaly.dev and example domains:"
  git grep -nIE -F -f /dev/stdin -- . "$self" <<LIST | cut -d: -f1,2
$emails
LIST
  fail=1
fi

terms=$(printf '%s\n%s\n' "${PUBLIC_SAFETY_TERMS:-}" "$( [ -f .public-safety.local ] && cat .public-safety.local )" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$' || true)
if [ -n "$terms" ]; then
  hits=$(printf '%s\n' "$terms" | git grep -nIiF -f /dev/stdin -- . "$self" | cut -d: -f1,2 || true)
  if [ -n "$hits" ]; then
    echo "private terms found at:"
    echo "$hits"
    fail=1
  fi
  echo "private terms checked: $(printf '%s\n' "$terms" | wc -l | tr -d ' ')"
else
  echo "private terms: none given (set PUBLIC_SAFETY_TERMS or .public-safety.local)"
fi

[ "$fail" -eq 0 ] && echo "public safety: clean"
exit "$fail"
