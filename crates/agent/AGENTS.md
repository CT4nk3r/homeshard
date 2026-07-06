# Host agent

The agent is a long-running Tokio worker. It heartbeats to Postgres, refreshes
instance status, claims queued commands, and runs independent instances
concurrently. Most behavior currently lives in `src/main.rs`.

## Working rules

- Keep `handle_command` aligned with the web command schema and payload shapes.
- Preserve claim semantics: commands for one instance must not overlap, orphaned
  claims must be recoverable, and every claimed command must finish or fail.
- Docker containers are managed resources. Retain ownership-label checks before
  destructive lifecycle or filesystem operations.
- Treat paths and uploaded filenames as untrusted. Keep traversal protections and
  the active/cold/staging directory boundaries intact.
- The agent uses the host Docker socket. Paths passed to Docker must be valid host
  paths, which is why active and cold roots use identity mounts.
- Persist useful failure state to Postgres so the dashboard can explain and retry it.

## Checks

Run `cargo fmt --check`, `cargo clippy --manifest-path crates/agent/Cargo.toml`, and
`cargo test --manifest-path crates/agent/Cargo.toml`. Add unit tests near pure
parsers, validation, version selection, and state-transition helpers.
