import Link from "next/link";
import { ArrowLeft, Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireMember } from "@/lib/auth";
import { CreateInstanceForm } from "./create-instance-form";

export const dynamic = "force-dynamic";

export default async function NewMinecraftInstancePage() {
  await requireMember();
  return (
    <main className="mx-auto min-h-screen max-w-3xl space-y-6 px-6 py-10">
      <Button asChild variant="ghost"><Link href="/"><ArrowLeft className="size-4" />Dashboard</Link></Button>
      <div><p className="font-mono text-xs uppercase tracking-[0.24em] text-primary">Minecraft</p><h1 className="mt-2 text-3xl font-semibold">Create instance</h1><p className="mt-2 text-muted-foreground">Smart defaults first. Advanced knobs stay out of the way.</p></div>
      <Alert><Info className="size-4" /><AlertTitle>Free-tier upload path</AlertTitle><AlertDescription>Small manifest packs can use temporary Blob staging. Large worlds should be copied to the homeserver import folder over Tailscale/SCP.</AlertDescription></Alert>
      <Card><CardHeader><CardTitle>Instance blueprint</CardTitle><CardDescription>Start from a generated world or attach a CurseForge/Modrinth pack ZIP. CurseForge packs install automatically from the pack ZIP.</CardDescription></CardHeader><CardContent><CreateInstanceForm /></CardContent></Card>
    </main>
  );
}
