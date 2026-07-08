import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download, FileArchive, MemoryStick, Pickaxe, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { requireMember } from "@/lib/auth";
import { getInstanceDetail } from "@/lib/instances";
import { blockedModsSummary, parseBlockedMods, tidyErrorMessage } from "@/lib/blocked-mods";
import { InstanceActions } from "@/components/instance-actions";
import { CommandActivity } from "./command-activity";
import { BackupManager } from "./backup-manager";
import { ConsolePanel } from "./console-panel";
import { InstanceNameEditor } from "./instance-name-editor";
import { ModManager } from "./mod-manager";

export const dynamic = "force-dynamic";

const STATE_BADGE: Record<string, string> = {
  running:   "text-[var(--success)]    bg-[var(--success-muted)]   border-[rgba(63,185,80,0.4)]",
  sleeping:  "text-[var(--text-faint)] bg-[var(--card)]            border-[var(--border)]",
  stopped:   "text-[var(--text-faint)] bg-[var(--card)]            border-[var(--border)]",
  deploying: "text-[var(--attention)]  bg-[var(--attention-muted)] border-[rgba(210,153,34,0.4)]",
  failed:    "text-[var(--danger)]     bg-[var(--danger-muted)]    border-[rgba(248,81,73,0.4)]",
  trashed:   "text-[var(--text-faint)] bg-[var(--card)]            border-[var(--border)]",
};

export default async function InstancePage({ params }: { params: Promise<{ id: string }> }) {
  await requireMember();
  const { id } = await params;
  const instance = await getInstanceDetail(id);
  if (!instance) notFound();

  const modsKey     = instance.mods.map((m) => `${m.filename}:${m.enabled}`).join("|");
  const defaultTab  = instance.state === "running" ? "console" : "activity";
  const reasonBlocked = instance.reason ? parseBlockedMods(instance.reason) : [];
  const badgeCls    = STATE_BADGE[instance.state] ?? STATE_BADGE.stopped;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* ── topbar ──────────────────────────────────────────────────── */}
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

      {/* ── two-column body ─────────────────────────────────────────── */}
      <div className="mx-auto flex w-full max-w-[1280px] flex-1">

        {/* sidebar: instance quick-info */}
        <aside className="w-[296px] flex-none border-r border-[var(--border-muted)] px-4 py-6 max-md:hidden">
          <div className="space-y-4">
            <div>
              <h2 className="mb-1 text-[13px] font-semibold text-foreground">{instance.name}</h2>
              <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${badgeCls}`}>
                <span className="size-1.5 rounded-full bg-current" />
                {instance.state}
              </span>
            </div>

            <div className="space-y-2 text-xs text-[var(--muted-foreground)]">
              <div className="flex items-center gap-2">
                <Pickaxe className="size-3.5 flex-none" />
                {instance.serverType} {instance.gameVersion}
              </div>
              <div className="flex items-center gap-2">
                <MemoryStick className="size-3.5 flex-none" />
                {Math.round(instance.memoryMb / 1024)} GiB allocated
              </div>
              <div className="pt-1 font-mono">
                {instance.magicDnsName || "your-server"}:{instance.port}
              </div>
            </div>

            <div className="pt-1">
              <InstanceActions instanceId={id} state={instance.state} />
            </div>
          </div>
        </aside>

        {/* main detail */}
        <main className="min-w-0 flex-1 px-6 py-6 pb-12">
          {/* header (mobile + desktop) */}
          <div className="mb-6 flex flex-col justify-between gap-4 border-b border-[var(--border-muted)] pb-5 md:flex-row md:items-start">
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1">
                  <h1 className="text-xl font-semibold">{instance.name}</h1>
                  <InstanceNameEditor instanceId={id} name={instance.name} />
                </div>
                <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${badgeCls}`}>
                  <span className="size-1.5 rounded-full bg-current" />
                  {instance.state}
                </span>
                <span className="rounded-md border border-[var(--border)] bg-transparent px-2 py-0.5 text-[11px] text-[var(--muted-foreground)]">
                  {instance.serverType} {instance.gameVersion}
                </span>
              </div>
              <p className="font-mono text-xs text-[var(--muted-foreground)]">
                {instance.magicDnsName || "your-server"}:{instance.port}
              </p>
            </div>
            {/* actions shown on mobile / hidden on md+ (shown in sidebar instead) */}
            <div className="md:hidden">
              <InstanceActions instanceId={id} state={instance.state} />
            </div>
          </div>

          {/* alert for failed / blocked mods */}
          {instance.reason && (
            <div className="mb-5 rounded-md border border-[rgba(248,81,73,0.4)] bg-[var(--danger-muted)] px-4 py-3">
              <p className="mb-0.5 text-[13px] font-semibold text-[var(--danger)]">Deployment needs attention</p>
              <p className="text-xs text-[var(--danger)]">
                {reasonBlocked.length
                  ? blockedModsSummary(reasonBlocked.length, "activity")
                  : tidyErrorMessage(instance.reason)}
              </p>
            </div>
          )}

          {/* tabs */}
          <Tabs defaultValue={defaultTab}>
            <TabsList className="mb-4 h-9 bg-[var(--border-muted)] p-1">
              <TabsTrigger value="activity">Activity</TabsTrigger>
              <TabsTrigger value="console">Console</TabsTrigger>
              <TabsTrigger value="mods">Mods</TabsTrigger>
              <TabsTrigger value="packs">Packs</TabsTrigger>
              <TabsTrigger value="files">Files</TabsTrigger>
              <TabsTrigger value="backups">Backups</TabsTrigger>
            </TabsList>

            <TabsContent value="activity">
              <CommandActivity instanceId={id} />
            </TabsContent>

            <TabsContent value="console">
              {instance.state === "running"
                ? <ConsolePanel instanceId={id} />
                : <Placeholder title="Console unavailable" description="Console access becomes available while the instance is running." />}
            </TabsContent>

            <TabsContent value="mods">
              <ModManager key={modsKey} instanceId={id} state={instance.state} mods={instance.mods} />
            </TabsContent>

            <TabsContent value="packs">
              <div className="grid gap-4">
                {instance.packs.length ? instance.packs.map((pack) => (
                  <PackCard key={pack.id} pack={pack} instanceId={id} />
                )) : (
                  <Placeholder title="No pack revisions" description="Generated-world instances do not have a source pack." />
                )}
              </div>
            </TabsContent>

            <TabsContent value="files">
              <Placeholder title="Instance files" description="The agent will expose a jailed file manager rooted at this instance directory." />
            </TabsContent>

            <TabsContent value="backups">
              <BackupManager
                instanceId={id}
                state={instance.state}
                worldSeed={instance.worldSeed}
                backups={instance.backups}
              />
            </TabsContent>
          </Tabs>
        </main>
      </div>
    </div>
  );
}

function PackCard({
  pack,
  instanceId,
}: {
  pack: { id: string; originalName: string; active: boolean; sizeBytes: number; sha256?: string | null; downloadable: boolean };
  instanceId: string;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-[var(--border-muted)] bg-[var(--card)]">
      <div className="flex items-center gap-3 border-b border-[var(--border-muted)] px-4 py-3">
        <FileArchive className="size-4 flex-none text-[var(--muted-foreground)]" />
        <span className="flex-1 text-[13px] font-semibold">{pack.originalName}</span>
        <span className="text-xs text-[var(--muted-foreground)]">
          {pack.active ? "Active" : "Archived"} · {Math.round(pack.sizeBytes / 1024)} KiB
        </span>
      </div>
      <div className="px-4 py-3 space-y-3">
        {pack.sha256 && (
          <p className="break-all font-mono text-xs text-[var(--muted-foreground)]">SHA-256 {pack.sha256}</p>
        )}
        {pack.downloadable ? (
          <Button asChild variant="outline" size="sm">
            <a href={`/api/instances/${instanceId}/packs/${pack.id}/download`} download>
              <Download className="size-4" />Download pack
            </a>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            <Download className="size-4" />File unavailable
          </Button>
        )}
      </div>
    </div>
  );
}

function Placeholder({ title, description }: { title: string; description: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-[var(--border-muted)] bg-[var(--card)]">
      <div className="border-b border-[var(--border-muted)] px-4 py-3">
        <p className="text-[13px] font-semibold">{title}</p>
      </div>
      <div className="px-4 py-4">
        <p className="mb-3 text-sm text-[var(--muted-foreground)]">{description}</p>
        <Button variant="outline" size="sm" disabled>
          <Download className="size-4" />Not yet available
        </Button>
      </div>
    </div>
  );
}
