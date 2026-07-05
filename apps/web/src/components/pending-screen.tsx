import { Clock3, Server } from "lucide-react";

export function PendingScreen() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-[62px] items-center gap-2 border-b border-[var(--border-muted)] px-6">
        <div className="flex size-[30px] items-center justify-center rounded-md border border-[var(--border)] bg-[var(--card)]">
          <Server className="size-4" />
        </div>
        <span className="text-[15px] font-semibold tracking-tight">homeshard</span>
      </header>
      <main className="grid flex-1 place-items-center p-6">
        <div className="w-full max-w-md overflow-hidden rounded-md border border-[var(--border-muted)] bg-[var(--card)]">
          <div className="border-b border-[var(--border-muted)] px-5 py-4">
            <div className="mb-3 flex size-10 items-center justify-center rounded-md border border-[rgba(210,153,34,0.4)] bg-[var(--attention-muted)]">
              <Clock3 className="size-5 text-[var(--attention)]" />
            </div>
            <p className="text-[15px] font-semibold">Access is waiting for approval</p>
            <p className="mt-1 text-sm text-[var(--muted-foreground)]">
              Your account is awaiting approval. An administrator needs to grant you access before you can use this dashboard.
            </p>
          </div>
          <div className="px-5 py-4">
            <p className="text-xs text-[var(--text-faint)]">
              Homeshard exposes no server information until the owner promotes this account.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
