import Link from "next/link";
import { ArrowLeft, Server } from "lucide-react";
import { requireMember } from "@/lib/auth";
import { CreateInstanceForm } from "./create-instance-form";

export const dynamic = "force-dynamic";

export default async function NewMinecraftInstancePage() {
  await requireMember();
  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* topbar */}
      <header className="sticky top-0 z-20 flex h-[62px] flex-none items-center gap-4 border-b border-[var(--border-muted)] bg-background px-6">
        <div className="flex items-center gap-2">
          <div className="flex size-[30px] items-center justify-center rounded-md border border-[var(--border)] bg-[var(--card)]">
            <Server className="size-4" />
          </div>
          <span className="text-[15px] font-semibold tracking-tight">homeshard</span>
        </div>
        <div className="h-[22px] w-px bg-[var(--border-muted)]" />
        <Link href="/" className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)] hover:text-foreground">
          <ArrowLeft className="size-3.5" />
          Dashboard
        </Link>
      </header>

      <main className="mx-auto w-full max-w-2xl px-6 py-8">
        <div className="mb-6">
          <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.24em] text-[var(--link)]">Minecraft</p>
          <h1 className="text-2xl font-semibold tracking-tight">Create instance</h1>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">Smart defaults first. Advanced knobs stay out of the way.</p>
        </div>

        <div className="mb-5 rounded-md border border-[rgba(47,129,247,0.4)] bg-[rgba(47,129,247,0.1)] px-4 py-3 text-xs text-[var(--link)]">
          <p className="font-semibold">Free-tier upload path</p>
          <p className="mt-0.5 text-[var(--muted-foreground)]">
            Small manifest packs can use temporary Blob staging. Large worlds should be copied to the homeserver import folder over Tailscale/SCP.
          </p>
        </div>

        <div className="overflow-hidden rounded-md border border-[var(--border-muted)] bg-[var(--card)]">
          <div className="border-b border-[var(--border-muted)] px-4 py-3">
            <p className="text-[13px] font-semibold">Instance blueprint</p>
            <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
              Start from a generated world or attach a CurseForge / Modrinth pack ZIP. CurseForge packs install automatically from the pack ZIP.
            </p>
          </div>
          <div className="px-4 py-4">
            <CreateInstanceForm />
          </div>
        </div>
      </main>
    </div>
  );
}
