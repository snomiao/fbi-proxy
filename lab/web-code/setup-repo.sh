# Repo setup for the web-code gateway.
#
# Run cross-platform via Bun Shell (`bun setup-repo.sh`) from inside a freshly
# provisioned worktree (cwd = the worktree). Pulls submodules and installs
# dependencies for whatever ecosystem(s) the repo uses, matching the committed
# lockfile / manifest.
#
# Best-effort by design: every step is guarded with `|| true` so a missing
# toolchain (no cargo, no go, …) or one ecosystem's hiccup never aborts the
# rest. Bun Shell has no `set -e`, which suits this fail-soft style. A repo may
# legitimately have several ecosystems (e.g. a Rust core + a JS frontend), so
# the language blocks are independent rather than mutually exclusive.

echo "[setup] preparing repo"

# Submodules (no-op if the repo has none).
git submodule update --init --recursive || true

# JS / TS — honor the committed lockfile, most specific first.
if [ -f bun.lock ]; then
  bun install || true
elif [ -f bun.lockb ]; then
  bun install || true
elif [ -f pnpm-lock.yaml ]; then
  pnpm install || true
elif [ -f yarn.lock ]; then
  yarn install || true
elif [ -f package-lock.json ]; then
  npm install || true
elif [ -f package.json ]; then
  bun install || true
fi

# Rust.
if [ -f Cargo.toml ]; then
  cargo fetch || true
fi

# Go.
if [ -f go.mod ]; then
  go mod download || true
fi

# Python — lockfile / manifest, most specific first.
if [ -f uv.lock ]; then
  uv sync || true
elif [ -f poetry.lock ]; then
  poetry install || true
elif [ -f Pipfile.lock ]; then
  pipenv install || true
elif [ -f requirements.txt ]; then
  pip install -r requirements.txt || true
fi

# Ruby.
if [ -f Gemfile.lock ]; then
  bundle install || true
fi

echo "[setup] done"
