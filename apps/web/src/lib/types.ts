export type UserRole = "pending" | "member" | "owner";
export type InstanceState =
  | "deploying"
  | "running"
  | "sleeping"
  | "stopped"
  | "failed"
  | "trashed";

export type DashboardInstance = {
  id: string;
  name: string;
  state: InstanceState;
  serverType: string;
  gameVersion: string;
  worldSeed?: string | null;
  port: number;
  memoryMb: number;
  players: number;
  maxPlayers: number;
  reason?: string;
};

export type InstanceMod = {
  filename: string;
  enabled: boolean;
  sizeBytes: number;
};

export type DashboardSnapshot = {
  demoMode: boolean;
  actor: { email: string; role: UserRole; displayName: string };
  host: {
    name: string;
    agentId: string;
    magicDnsName: string;
    status: "online" | "offline" | "demo";
    lastSeenAt: string | null;
    lastSeenLabel: string;
    memoryUsedGb: number;
    memoryTotalGb: number;
    nvmeFreeGb: number;
    coldUsedGb: number;
    coldLimitGb: number;
  };
  instances: DashboardInstance[];
  pendingUsers: number;
  activeAlerts: number;
};
