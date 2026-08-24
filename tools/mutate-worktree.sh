#!/usr/bin/env bash
# Run the mutation suite against a throwaway git worktree.
#
# The runner edits source files in place. Doing that in the working tree you are
# using means two things go wrong at once: your edits land in the middle of a
# run, so its results describe a file nobody wrote, and the runner's restore
# writes its own copy back over whatever you changed in the meantime. Both
# happened before this script existed.
#
# A worktree gives the runner its own checkout of HEAD to chew on, so the tree
# you are working in is never touched and you can keep editing while it runs.
#
#   ./tools/mutate-worktree.sh            # every mutation
#   ./tools/mutate-worktree.sh --only 3   # whatever flags test/mutate.js takes
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"

if [ -n "$(git status --porcelain)" ]; then
  echo "mutate-worktree: uncommitted changes — the worktree is built from HEAD," >&2
  echo "                 so anything not committed would not be tested." >&2
  exit 1
fi

dir=$(mktemp -d "${TMPDIR:-/tmp}/skate-mutate.XXXXXX")
cleanup() {
  cd "$root"
  git worktree remove --force "$dir" >/dev/null 2>&1 || rm -rf "$dir"
}
trap cleanup EXIT INT TERM

git worktree add --detach --quiet "$dir" HEAD
# node_modules is only eslint, and the mutation runner shells out to the test
# runners rather than linting. Link it so the worktree needs no install.
ln -s "$root/node_modules" "$dir/node_modules"

cd "$dir"
node test/mutate.js "$@"
