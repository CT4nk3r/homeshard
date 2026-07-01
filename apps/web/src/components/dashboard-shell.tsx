import Link from "next/link";
import {
  Activity,
  Bell,
  Box,
  Gamepad2,
  HardDrive,
  MemoryStick,
  Pickaxe,
  Plus,
  Server,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import type { DashboardSnapshot } from "@/lib/types";
import { blockedModsSummary, parseBlockedMods, tidyErrorMessage } from "@/lib/blocked-mods";
import { InstanceActions } from "./instance-actions";

const stateTone: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  running: "default",
  sleeping: "secondary",
  stopped: "outline",
  failed: "destructive",
  deploying: "secondary",
};

export function DashboardShell({ snapshot }: { snapshot: DashboardSnapshot }) {
  const running = snapshot.instances.filter((instance) => instance.state === "running").length;
  const sleeping = snapshot.instances.filter((instance) => instance.state === "sleeping").length;
  const nvmeUsed = Math.max(0, 100 - (snapshot.host.nvmeFreeGb / 928) * 100);
  const coldUsed = (snapshot.host.coldUsedGb / snapshot.host.coldLimitGb) * 100;

  const agentLabel = snapshot.host.status === "demo" ? "Demo mode" : `Agent ${snapshot.host.status}`;
  const agentBadgeVariant =
    snapshot.host.status === "online" ? "default" : snapshot.host.status === "demo" ? "secondary" : "destructive";

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,oklch(0.25_0.08_150/0.2),transparent_28rem)]">
      <header className="border-b border-border/70 bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-primary/15 p-2 text-primary"><Box className="size-5" /></div>
            <div><p className="font-semibold tracking-tight">Homeshard</p><p className="text-xs text-muted-foreground">Homeserver control plane</p></div>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant={agentBadgeVariant}>{agentLabel}</Badge>
            <div className="hidden text-right sm:block"><p className="text-sm font-medium">{snapshot.actor.displayName}</p><p className="text-xs text-muted-foreground">{snapshot.actor.role}</p></div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-8 px-6 py-8">
        <section className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div><p className="mb-2 font-mono text-xs uppercase tracking-[0.24em] text-primary">Dashboard</p><h1 className="text-3xl font-semibold tracking-tight">Good to see you, {snapshot.actor.displayName}.</h1><p className="mt-2 text-muted-foreground">Manage the shard. Keep the host boring.</p></div>
          <Button asChild><Link href="/minecraft/new"><Plus className="size-4" />Create Minecraft instance</Link></Button>
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          <GameCard title="Minecraft" description={`${snapshot.instances.length} instances · ${running} running · ${sleeping} sleeping`} icon={<Pickaxe className="size-5" />} href="#instances" />
          <GameCard title="Terraria" description="Driver planned after Minecraft v1" icon={<Gamepad2 className="size-5" />} comingSoon />
          <GameCard title="Valheim" description="Driver planned after Minecraft v1" icon={<Gamepad2 className="size-5" />} comingSoon />
        </section>

        <section className="grid gap-4 lg:grid-cols-4">
          <MetricCard icon={<Server className="size-4" />} label="Agent" value={snapshot.host.status} detail={snapshot.demoMode ? "Neon not connected yet" : snapshot.host.name} />
          <MetricCard icon={<MemoryStick className="size-4" />} label="Memory" value={`${snapshot.host.memoryUsedGb} / ${snapshot.host.memoryTotalGb} GiB`} detail="8 GiB host reserve" />
          <MetricCard icon={<HardDrive className="size-4" />} label="NVMe free" value={`${snapshot.host.nvmeFreeGb} GiB`} detail={<Progress value={nvmeUsed} className="mt-2 h-1.5" />} />
          <MetricCard icon={<Bell className="size-4" />} label="Attention" value={`${snapshot.activeAlerts} alerts`} detail={`${snapshot.pendingUsers} pending users`} />
        </section>

        <section id="instances" className="space-y-4 scroll-mt-8">
          <div className="flex items-center justify-between"><div><h2 className="text-xl font-semibold">Minecraft instances</h2><p className="text-sm text-muted-foreground">Gameplay stays private through Tailscale.</p></div><Badge variant="outline">Ports 25600-25699</Badge></div>
          <div className="grid gap-4">
            {snapshot.instances.map((instance) => (
              <Card key={instance.id} className="border-border/70 bg-card/80">
                <CardContent className="grid gap-5 p-5 md:grid-cols-[1fr_auto] md:items-center">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2"><Link href={`/minecraft/${instance.id}`} className="text-lg font-semibold hover:text-primary">{instance.name}</Link><Badge variant={stateTone[instance.state] ?? "outline"}>{instance.state}</Badge><Badge variant="outline">{instance.serverType} {instance.gameVersion}</Badge></div>
                    <p className="font-mono text-xs text-muted-foreground">{snapshot.host.magicDnsName || snapshot.host.name}:{instance.port}</p>
                    {instance.reason && <p className="text-sm text-destructive">{formatInstanceReason(instance.reason)}</p>}
                    <div className="flex gap-5 text-sm text-muted-foreground"><span className="flex items-center gap-1.5"><Users className="size-3.5" />{instance.players}/{instance.maxPlayers}</span><span className="flex items-center gap-1.5"><MemoryStick className="size-3.5" />{Math.round(instance.memoryMb / 1024)} GiB</span></div>
                  </div>
                  <InstanceActions instanceId={instance.id} state={instance.state} disabled={snapshot.demoMode} />
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><HardDrive className="size-4" />Cold storage</CardTitle><CardDescription>Backups, packs, and trash on the 2 TB HDD.</CardDescription></CardHeader><CardContent><div className="mb-2 flex justify-between text-sm"><span>{snapshot.host.coldUsedGb} GiB used</span><span className="text-muted-foreground">{snapshot.host.coldLimitGb} GiB cap</span></div><Progress value={coldUsed} /></CardContent></Card>
          <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Activity className="size-4" />Free-tier posture</CardTitle><CardDescription>Cloud state stays compact; heavy data stays home.</CardDescription></CardHeader><CardContent className="space-y-3 text-sm text-muted-foreground"><p>Neon stores commands and summaries only.</p><Separator /><p>Vercel Blob is temporary staging for small packs.</p></CardContent></Card>
          {snapshot.actor.role === "owner" && <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Box className="size-4" />Prism imports</CardTitle><CardDescription>Mounted Prism Launcher instances directory.</CardDescription></CardHeader><CardContent><Badge variant={snapshot.host.prismInstancesConfigured ? "default" : "destructive"}>{snapshot.host.prismInstancesConfigured ? "Mounted" : "Not mounted"}</Badge><p className="mt-3 text-sm text-muted-foreground">CurseForge packs deploy by copying a matching fresh Prism import.</p></CardContent></Card>}
        </section>
      </main>
    </div>
  );
}

function GameCard({ title, description, icon, href, comingSoon }: { title: string; description: string; icon: React.ReactNode; href?: string; comingSoon?: boolean }) {
  const body = <Card className="relative h-full border-border/70 bg-card/70 transition-colors hover:border-primary/40"><CardHeader><div className="mb-4 flex items-center justify-between"><div className="rounded-lg bg-secondary p-2 text-primary">{icon}</div>{comingSoon && <Badge className="bg-yellow-500/15 text-yellow-300 hover:bg-yellow-500/15">Coming soon</Badge>}</div><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader></Card>;
  return href ? <Link href={href}>{body}</Link> : body;
}

function MetricCard({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: React.ReactNode }) {
  return <Card className="border-border/70 bg-card/70"><CardContent className="p-5"><div className="mb-4 flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">{icon}{label}</div><p className="font-mono text-lg font-semibold capitalize">{value}</p><div className="mt-1 text-xs text-muted-foreground">{detail}</div></CardContent></Card>;
}

function formatInstanceReason(reason: string): string {
  const blocked = parseBlockedMods(reason);
  if (blocked.length) return blockedModsSummary(blocked.length, "activity");
  return tidyErrorMessage(reason);
}
