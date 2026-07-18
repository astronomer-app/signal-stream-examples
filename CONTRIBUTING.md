# Contributing

Thanks for adding a Signal Stream example. The goal is that anyone can copy a
single folder into their own project and have it run.

## Layout

Examples are organized **by broker, then language**:

```
<broker>/<language>/
```

e.g. `alpaca/node`, `alpaca/go`, `etrade/node`. Use lowercase, hyphen-free
names that match the broker's and language's common spelling.

## What every example must have

- **A self-contained project.** Its own manifest (`package.json`, `go.mod`,
  `requirements.txt`, …), its own `README.md`, and its own `.env.example`. No
  imports from sibling examples, no shared root tooling to install.
- **A pinned, published SDK.** Depend on the released Signal Stream client
  (e.g. `@astronomer-app/signals` from npm), not a local path. An example must
  build from a clean clone with no extra setup.
- **A dry-run mode.** With no broker keys set, log what *would* happen and send
  no orders, so people can run it before trading.
- **Paper/sandbox by default.** Default any broker base URL to the paper or
  sandbox endpoint. Make going live an explicit, documented opt-in.
- **A README** covering setup, the env vars, how to run, and a short "Going to
  production" section listing what's intentionally left out (idempotency, risk
  limits, quote quality, etc.).

## When you add one

1. Create `<broker>/<language>/` with the files above.
2. Add a row/cell to the matrix in the root [README](README.md).
3. If it's a language with CI, make sure it's picked up by the workflow in
   `.github/workflows/`.
