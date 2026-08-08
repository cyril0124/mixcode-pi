# mpi-error-continue

When an agent turn **settles on `stopReason: "error"`** (Pi built-in auto-retry did not recover), automatically:

1. Up to **3 invisible continues** (hidden custom marker, filtered from LLM context), with exponential backoff `1s / 2s / 4s`
2. Then up to **3 visible** `continue` user prompts, same backoff
3. Status bar: `error-continue: on (N)` cumulative sends this session

## Commands

| Command | Effect |
|---------|--------|
| `/error-continue on` | Enable for this session (default if no state) |
| `/error-continue off` | Disable; persists in session branch |

## Local load (not installed by MixCode)

```bash
pi -e ./other-pi-packages/mpi-error-continue/index.ts
# or
mpi -e ./other-pi-packages/mpi-error-continue/index.ts
```

## Test

```bash
bun test --isolate --timeout=60000 other-pi-packages/mpi-error-continue/error-continue.test.ts
```
