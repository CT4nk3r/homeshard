<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Web control plane

This is a Next.js 16 App Router app. Pages and route handlers live in `src/app`,
interactive UI in `src/components`, shared server/domain logic in `src/lib`, and
the Drizzle schema in `src/db/schema.ts`. `src/components/ui` contains shadcn
primitives; compose those instead of duplicating base controls.

## Important contracts

- API routes must authenticate mutations with `requireMember()` and validate input.
- The app queues work in `commands`; it must not manage Docker directly. Keep command
  kinds and payloads aligned with `crates/agent/src/main.rs`.
- Database access supports Neon HTTP by default and `postgresjs` in Compose.
- Without Clerk, auth intentionally falls back to the owner demo identity.
- Pack/mod uploads may use Vercel Blob or local staging. Validate names, sizes, and
  paths in both flows and never trust client filenames.
- Change `src/db/schema.ts` and add a generated file under `drizzle/` together.

## Checks

From the repository root, run `pnpm --filter web test`, `pnpm --filter web lint`,
and `pnpm --filter web build` for changes that affect rendering or server behavior.
