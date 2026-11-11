#!/usr/bin/env bash
set -euo pipefail
# Scan tracked + staged files for secret-shaped values. Never prints the matched value.
cd "$(git rev-parse --show-toplevel)"
pattern='sk-[[:alnum:]_-]{16,}|AKIA[[:alnum:]]{16}|gh[pousr]_[[:alnum:]]{20,}|github_pat_[[:alnum:]_]{20,}|-----BEGIN ([A-Z]+ )?PRIVATE KEY-----|eyJ[[:alnum:]_-]{20,}\.[[:alnum:]_-]{20,}|(x-api-key|api[_-]?key|client[_-]?secret|webhook[_-]?secret)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][[:alnum:]_/+=-]{16,}'
failed=0
while IFS= read -r -d '' file; do
  case "${file##*/}" in
    .env.example) ;;
    .env*) printf 'Forbidden tracked environment file: %s\n' "$file" >&2; failed=1; continue ;;
  esac
  [[ -f "$file" && ! -L "$file" ]] || continue
  if grep -aqE -- "$pattern" "$file"; then
    printf 'Possible secret in %s (value not shown)\n' "$file" >&2
    failed=1
  fi
done < <(git ls-files -z --cached --others --exclude-standard)
exit "$failed"
