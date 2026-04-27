# Memory Cockpit CLI Examples

Run these from the repo root while developing the local CLI. When launched through `pnpm cockpit:dev`, the CLI uses pnpm's original shell directory as the default workspace.

## Setup

```bash
pnpm install
pnpm cockpit:dev -- doctor
LEDGERMIND_DB_URL=postgres://user:pass@localhost:5432/ledgermind pnpm cockpit:dev -- status
```

`doctor` can run without a database. Memory commands such as `remember`, `recall`, `timeline`, `explain`, and `source` need `LEDGERMIND_DB_URL` or `--db`.

## Remember

```bash
LEDGERMIND_DB_URL=postgres://user:pass@localhost:5432/ledgermind pnpm cockpit:dev -- remember "The CLI writes manual notes into the active workspace conversation."
```

Use `--workspace`, `--branch`, or `--runtime-session` when you need a more specific binding than the default workspace session.

## Recall

```bash
LEDGERMIND_DB_URL=postgres://user:pass@localhost:5432/ledgermind pnpm cockpit:dev -- recall "manual notes"
LEDGERMIND_DB_URL=postgres://user:pass@localhost:5432/ledgermind pnpm cockpit:dev -- timeline
LEDGERMIND_DB_URL=postgres://user:pass@localhost:5432/ledgermind pnpm cockpit:dev -- explain sum_example
```

## Agent-Readable Output

Every command accepts `--json`.

```bash
LEDGERMIND_DB_URL=postgres://user:pass@localhost:5432/ledgermind pnpm cockpit:dev -- status --json
LEDGERMIND_DB_URL=postgres://user:pass@localhost:5432/ledgermind pnpm cockpit:dev -- recall "manual notes" --json
```

## Source Lineage

`source <summary-id> --yes` reveals raw source messages and requires a child runtime binding. First bind or reuse the parent session, then call `source` from a fresh child session:

```bash
LEDGERMIND_DB_URL=postgres://user:pass@localhost:5432/ledgermind pnpm cockpit:dev -- status --runtime-session parent
LEDGERMIND_DB_URL=postgres://user:pass@localhost:5432/ledgermind pnpm cockpit:dev -- source sum_example --yes --runtime-session child --parent-runtime-session parent
```
