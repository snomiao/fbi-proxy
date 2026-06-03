# intentionally empty

`vite.config.ts` sets `envDir` to this directory so vite's env-file loader has
nothing to find — it never reads `.env` / `.env.local` from this lab or the
repo root. The shell server runs purely on the system/default process env.

Do not add `.env*` files here. (This README only exists to keep the otherwise
empty dir in git.)
