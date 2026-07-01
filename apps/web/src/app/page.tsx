import { DashboardShell } from "@/components/dashboard-shell";
import { PendingScreen } from "@/components/pending-screen";
import { SignInScreen } from "@/components/sign-in-screen";
import { getActor } from "@/lib/auth";
import { getDashboardSnapshot } from "@/lib/dashboard";

export const dynamic = "force-dynamic";

export default async function Home() {
  const actor = await getActor();
  if (!actor.clerkId) return <SignInScreen />;
  if (actor.role === "pending") return <PendingScreen />;
  return <DashboardShell snapshot={await getDashboardSnapshot(actor)} />;
}
