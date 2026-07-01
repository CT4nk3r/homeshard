import { Clock3 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function PendingScreen() {
  return <main className="grid min-h-screen place-items-center p-6">
    <Card className="max-w-lg border-border/70 bg-card/85">
      <CardHeader>
        <div className="mb-4 w-fit rounded-xl bg-yellow-500/15 p-3 text-yellow-300"><Clock3 className="size-6" /></div>
        <CardTitle>Access is waiting for approval</CardTitle>
        <CardDescription>Your account is awaiting approval. An administrator needs to grant you access before you can use this dashboard.</CardDescription>
      </CardHeader>
      <CardContent><p className="text-sm text-muted-foreground">Homeshard exposes no server information until the owner promotes this account.</p></CardContent>
    </Card>
  </main>;
}
