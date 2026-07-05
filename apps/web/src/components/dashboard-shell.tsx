"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  Bell,
  HardDrive,
  MemoryStick,
  Pickaxe,
  Plus,
  Server,
  Users,
} from "lucide-react";
import type { DashboardSnapshot, DashboardInstance } from "@/lib/types";
import { blockedModsSummary, parseBlockedMods, tidyErrorMessage } from "@/lib/blocked-mods";
import { InstanceActions } from "./instance-actions";

const STATE_DOT: Record<string, string> = {
  running:   "bg-[var(--success)] pulse-dot",
  sleeping:  "bg-[var(--text-faint)]",
  stopped:   "bg-[var(--text-faint)]",
  deploying: "bg-[var(--attention)] pulse-dot",
  failed:    "bg-[var(--danger)]",
  trashed:   "bg-[var(--border)]",
};

const STATE_BADGE: Record<string, string> = {
  running:   "text-[var(--success)]   bg-[var(--success-muted)]    border-[rgba(63,185,80,0.4)]",
  sleeping:  "text-[var(--text-faint)] bg-[var(--card)]            border-[var(--border)]",
  stopped:   "text-[var(--text-faint)] bg-[var(--card)]            border-[var(--border)]",
  deploying: "text-[var(--attention)] bg-[var(--attention-muted)]  border-[rgba(210,153,34,0.4)]",
  failed:    "text-[var(--danger)]    bg-[var(--danger-muted)]     border-[rgba(248,81,73,0.4)]",
  trashed:   "text-[var(--text-faint)] bg-[var(--card)]            border-[var(--border)]",
};

export function DashboardShell({ snapshot }: { snapshot: DashboardSnapshot }) {
  const router = useRouter();
  const running  = snapshot.instances.filter((i) => i.state === "running").length;
  const nvmeUsed = Math.max(0, 100 - (snapshot.host.nvmeFreeGb / 928) * 100);
  const coldUsed = (snapshot.host.coldUsedGb / snapshot.host.coldLimitGb) * 100;
  const agentOnline = snapshot.host.status === "online";

  useEffect(() => {
    const refresh = () => router.refresh();
    const interval = window.setInterval(refresh, 15_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router]);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* ── topbar ─────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 flex h-[62px] flex-none items-center gap-4 border-b border-[var(--border-muted)] bg-background px-6">
        <div className="flex items-center gap-2">
          <div className="flex size-[30px] items-center justify-center rounded-md border border-[var(--border)] bg-[var(--card)]">
            <Server className="size-4" />
          </div>
          <span className="text-[15px] font-semibold tracking-tight">homeshard</span>
        </div>

        <div className="h-[22px] w-px bg-[var(--border-muted)]" />

        <div className="flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--card)] px-2.5 py-1 text-xs text-[var(--muted-foreground)]">
          <span className={`size-1.5 flex-none rounded-full ${agentOnline ? "bg-[var(--success)] pulse-dot" : "bg-[var(--text-faint)]"}`} />
          Agent {snapshot.host.status} · {snapshot.host.lastSeenLabel}
        </div>

        <div className="hidden items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--card)] px-2.5 py-1 text-xs text-[var(--muted-foreground)] sm:flex">
          <span className="size-1.5 flex-none rounded-full bg-[var(--link)]" />
          {snapshot.host.agentId}
        </div>

        <div className="flex-1" />

        <Link
          href="/minecraft/new"
          className="inline-flex items-center gap-1.5 rounded-md border border-[rgba(240,246,252,0.1)] bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-[var(--btn-primary-hover)]"
        >
          <Plus className="size-3.5" />
          New instance
        </Link>
      </header>

      {/* ── two-column body ─────────────────────────────────────────── */}
      <div className="mx-auto flex w-full max-w-[1280px] flex-1">

        {/* ── sidebar ─────────────────────────────────────────────── */}
        <aside className="w-[296px] flex-none border-r border-[var(--border-muted)] p-4 max-md:hidden">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Instances</h2>
            <span className="text-xs text-[var(--muted-foreground)]">{snapshot.instances.length}</span>
          </div>

          <div className="flex flex-col gap-1.5" role="list" aria-label="Server instances">
            {snapshot.instances.length === 0 && (
              <p className="py-6 text-center text-xs text-[var(--text-faint)]">No instances yet</p>
            )}
            {snapshot.instances.map((inst) => (
              <Link
                key={inst.id}
                href={`/minecraft/${inst.id}`}
                role="listitem"
                className="group block rounded-md border border-[var(--border)] bg-transparent px-3 py-2.5 transition-colors hover:border-[var(--border-interactive)] hover:bg-[var(--card)]"
              >
                <div className="mb-1 flex items-center gap-1.5">
                  <span className={`size-2 flex-none rounded-full ${STATE_DOT[inst.state] ?? "bg-[var(--text-faint)]"}`} />
                  <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-semibold">
                    {inst.name}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs text-[var(--muted-foreground)]">
                  <span className="flex items-center gap-1">
                    <Pickaxe className="size-3" />
                    {inst.serverType} {inst.gameVersion}
                  </span>
                  <span className="flex items-center gap-1">
                    <Users className="size-3" />
                    {inst.players}/{inst.maxPlayers}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </aside>

        {/* ── main detail area ─────────────────────────────────────── */}
        <main className="min-w-0 flex-1 overflow-y-auto px-6 py-6 pb-12">
          {/* greeting */}
          <div className="mb-6">
            <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.24em] text-[var(--link)]">Dashboard</p>
            <h1 className="text-2xl font-semibold tracking-tight">
              Good to see you, {snapshot.actor.displayName}.
            </h1>
            <p className="mt-1 text-sm text-[var(--muted-foreground)]">Manage the shard. Keep the host boring.</p>
          </div>

          {/* host stat grid */}
          <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Agent"        value={snapshot.host.status}                              sub={snapshot.demoMode ? "Demo mode" : `${snapshot.host.agentId} · ${snapshot.host.lastSeenLabel}`} />
            <StatCard label="Memory"       value={`${snapshot.host.memoryUsedGb} / ${snapshot.host.memoryTotalGb} GiB`} sub="8 GiB host reserve" />
            <StatCard label="NVMe free"    value={`${snapshot.host.nvmeFreeGb} GiB`}                 sub={<BarFill pct={nvmeUsed} />} />
            <StatCard label="Cold storage" value={`${snapshot.host.coldUsedGb} / ${snapshot.host.coldLimitGb} GiB`}    sub={<BarFill pct={coldUsed} />} />
          </div>

          {/* alerts */}
          {(snapshot.activeAlerts > 0 || snapshot.pendingUsers > 0) && (
            <div className="mb-5 flex flex-wrap gap-3">
              {snapshot.activeAlerts > 0 && (
                <div className="flex items-center gap-2 rounded-md border border-[rgba(210,153,34,0.4)] bg-[var(--attention-muted)] px-3 py-2 text-xs text-[var(--attention)]">
                  <Bell className="size-3.5" />
                  {snapshot.activeAlerts} active alert{snapshot.activeAlerts !== 1 ? "s" : ""}
                </div>
              )}
              {snapshot.pendingUsers > 0 && (
                <div className="flex items-center gap-2 rounded-md border border-[rgba(47,129,247,0.4)] bg-[rgba(47,129,247,0.1)] px-3 py-2 text-xs text-[var(--link)]">
                  <Users className="size-3.5" />
                  {snapshot.pendingUsers} pending user{snapshot.pendingUsers !== 1 ? "s" : ""}
                </div>
              )}
            </div>
          )}

          {/* instance panel */}
          <div className="overflow-hidden rounded-md border border-[var(--border-muted)] bg-[var(--card)]">
            <div className="flex items-center justify-between border-b border-[var(--border-muted)] px-4 py-3">
              <span className="text-[13px] font-semibold">Minecraft instances</span>
              <span className="text-xs text-[var(--muted-foreground)]">
                {running} running · {snapshot.instances.length} total · ports 25600–25699
              </span>
            </div>

            {snapshot.instances.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-[var(--text-faint)]">
                No instances yet.{" "}
                <Link href="/minecraft/new" className="text-[var(--link)] hover:underline">
                  Create one
                </Link>
                .
              </div>
            ) : (
              <div className="divide-y divide-[var(--border-muted)]">
                {snapshot.instances.map((inst) => (
                  <InstanceRow key={inst.id} instance={inst} host={snapshot.host} demoMode={snapshot.demoMode} />
                ))}
              </div>
            )}
          </div>

          {/* free-tier posture */}
          <div className="mt-5 overflow-hidden rounded-md border border-[var(--border-muted)] bg-[var(--card)]">
            <div className="flex items-center gap-2 border-b border-[var(--border-muted)] px-4 py-3">
              <Activity className="size-4 text-[var(--muted-foreground)]" />
              <span className="text-[13px] font-semibold">Free-tier posture</span>
            </div>
            <div className="space-y-0 divide-y divide-[var(--border-muted)]">
              <p className="px-4 py-2.5 text-xs text-[var(--muted-foreground)]">Neon stores commands and summaries only.</p>
              <p className="px-4 py-2.5 text-xs text-[var(--muted-foreground)]">Vercel Blob is temporary staging for small packs.</p>
              <p className="flex items-center gap-1.5 px-4 py-2.5 text-xs text-[var(--muted-foreground)]">
                <HardDrive className="size-3.5 flex-none" />
                Cold HDD: {snapshot.host.coldUsedGb} GiB / {snapshot.host.coldLimitGb} GiB
              </p>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

/* ── sub-components ──────────────────────────────────────────────── */

function StatCard({ label, value, sub }: { label: string; value: string; sub: React.ReactNode }) {
  return (
    <div className="rounded-md border border-[var(--border-muted)] bg-[var(--card)] p-4">
      <p className="mb-2 text-xs text-[var(--muted-foreground)]">{label}</p>
      <p className="font-mono text-lg font-semibold capitalize tracking-tight">{value}</p>
      <div className="mt-1 text-xs text-[var(--muted-foreground)]">{sub}</div>
    </div>
  );
}

function BarFill({ pct }: { pct: number }) {
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--border-muted)]">
      <div
        className="h-full rounded-full bg-[var(--link)] transition-[width] duration-700"
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  );
}

function InstanceRow({
  instance,
  host,
  demoMode,
}: {
  instance: DashboardInstance;
  host: DashboardSnapshot["host"];
  demoMode: boolean;
}) {
  const blocked = instance.reason ? parseBlockedMods(instance.reason) : [];

  return (
    <div className="grid gap-4 px-4 py-4 md:grid-cols-[1fr_auto] md:items-start">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`size-2 flex-none rounded-full ${STATE_DOT[instance.state] ?? "bg-[var(--text-faint)]"}`} />
          <Link
            href={`/minecraft/${instance.id}`}
            className="text-[15px] font-semibold text-foreground hover:text-[var(--link)]"
          >
            {instance.name}
          </Link>
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATE_BADGE[instance.state] ?? STATE_BADGE.stopped}`}
          >
            <span className="size-1.5 rounded-full bg-current" />
            {instance.state}
          </span>
          <span className="rounded-md border border-[var(--border)] bg-transparent px-2 py-0.5 text-[11px] text-[var(--muted-foreground)]">
            {instance.serverType} {instance.gameVersion}
          </span>
        </div>

        <p className="font-mono text-xs text-[var(--muted-foreground)]">
          {host.magicDnsName || host.name}:{instance.port}
        </p>

        {instance.reason && (
          <p className="text-xs text-[var(--danger)]">
            {blocked.length ? blockedModsSummary(blocked.length, "activity") : tidyErrorMessage(instance.reason)}
          </p>
        )}

        <div className="flex gap-4 text-xs text-[var(--muted-foreground)]">
          <span className="flex items-center gap-1.5">
            <Users className="size-3.5" />
            {instance.players}/{instance.maxPlayers}
          </span>
          <span className="flex items-center gap-1.5">
            <MemoryStick className="size-3.5" />
            {Math.round(instance.memoryMb / 1024)} GiB
          </span>
        </div>
      </div>

      <InstanceActions instanceId={instance.id} state={instance.state} disabled={demoMode} />
    </div>
  );
}
