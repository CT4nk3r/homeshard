import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download, FileArchive } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { requireMember } from "@/lib/auth";
import { getInstanceDetail } from "@/lib/instances";
import { blockedModsSummary, parseBlockedMods, tidyErrorMessage } from "@/lib/blocked-mods";
import { InstanceActions } from "@/components/instance-actions";
import { CommandActivity } from "./command-activity";
import { ConsolePanel } from "./console-panel";
import { ModManager } from "./mod-manager";

export const dynamic = "force-dynamic";

export default async function InstancePage({ params }: { params: Promise<{ id: string }> }) {
  await requireMember();
  const { id } = await params;
  const instance = await getInstanceDetail(id);
  if (!instance) notFound();
  const modsKey = instance.mods.map((mod) => `${mod.filename}:${mod.enabled}`).join("|");
  const defaultTab = instance.state === "running" ? "console" : "activity";
  const reasonBlocked = instance.reason ? parseBlockedMods(instance.reason) : [];

  return (
    <main className="mx-auto min-h-screen max-w-6xl space-y-6 px-6 py-10">
      <Button asChild variant="ghost"><Link href="/"><ArrowLeft className="size-4" />Dashboard</Link></Button>
      <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div>
          <div className="flex flex-wrap items-center gap-2"><h1 className="text-3xl font-semibold">{instance.name}</h1><Badge variant="secondary">{instance.state}</Badge><Badge variant="outline">{instance.serverType} {instance.gameVersion}</Badge></div>
          <p className="mt-2 font-mono text-sm text-muted-foreground">{instance.magicDnsName || "your-server"}:{instance.port}</p>
        </div>
        <InstanceActions instanceId={id} state={instance.state} />
      </div>
      {instance.reason && (
        <Alert variant="destructive">
          <AlertTitle>Deployment needs attention</AlertTitle>
          <AlertDescription>
            {reasonBlocked.length ? blockedModsSummary(reasonBlocked.length, "activity") : tidyErrorMessage(instance.reason)}
          </AlertDescription>
        </Alert>
      )}
      <Tabs defaultValue={defaultTab}>
        <TabsList><TabsTrigger value="activity">Activity</TabsTrigger><TabsTrigger value="console">Console & logs</TabsTrigger><TabsTrigger value="mods">Mods</TabsTrigger><TabsTrigger value="packs">Pack revisions</TabsTrigger><TabsTrigger value="files">Files</TabsTrigger><TabsTrigger value="backups">Backups</TabsTrigger></TabsList>
        <TabsContent value="activity"><CommandActivity instanceId={id} /></TabsContent>
        <TabsContent value="console">{instance.state === "running" ? <ConsolePanel instanceId={id} /> : <Placeholder title="Console unavailable" description="Console access becomes available while the instance is running." />}</TabsContent>
        <TabsContent value="mods"><ModManager key={modsKey} instanceId={id} state={instance.state} mods={instance.mods} /></TabsContent>
        <TabsContent value="packs"><div className="grid gap-4">{instance.packs.length ? instance.packs.map((pack) => <Card key={pack.id}><CardHeader><CardTitle className="flex items-center gap-2 text-base"><FileArchive className="size-4" />{pack.originalName}</CardTitle><CardDescription>{pack.active ? "Active revision" : "Archived revision"} · {Math.round(pack.sizeBytes / 1024)} KiB</CardDescription></CardHeader><CardContent><p className="break-all font-mono text-xs text-muted-foreground">SHA-256 {pack.sha256}</p></CardContent></Card>) : <Placeholder title="No pack revisions" description="Generated-world instances do not have a source pack." />}</div></TabsContent>
        <TabsContent value="files"><Placeholder title="Instance files" description="The agent will expose a jailed file manager rooted at this instance directory." /></TabsContent>
        <TabsContent value="backups"><Placeholder title="Backups" description="Restic snapshots, pinned backups, restore, and trash retention land here." /></TabsContent>
      </Tabs>
    </main>
  );
}

function Placeholder({ title, description }: { title: string; description: string }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader><CardContent><Button variant="outline" disabled><Download className="size-4" />Not yet available</Button></CardContent></Card>;
}
