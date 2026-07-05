"use client";

import { SignIn } from "@clerk/nextjs";
import { LockKeyhole, Server } from "lucide-react";

export function SignInScreen() {
  if (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <header className="flex h-[62px] items-center gap-2 border-b border-[var(--border-muted)] px-6">
          <div className="flex size-[30px] items-center justify-center rounded-md border border-[var(--border)] bg-[var(--card)]">
            <Server className="size-4" />
          </div>
          <span className="text-[15px] font-semibold tracking-tight">homeshard</span>
        </header>
        <main className="grid flex-1 place-items-center p-6">
          <SignIn />
        </main>
      </div>
    );
  }

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
          <div className="px-5 py-5">
            <div className="mb-4 flex size-10 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--secondary)]">
              <LockKeyhole className="size-5 text-[var(--muted-foreground)]" />
            </div>
            <p className="text-[15px] font-semibold">Authentication is not configured</p>
            <p className="mt-1 text-sm text-[var(--muted-foreground)]">
              Add Clerk keys to enable sign-in. Local demo mode signs in as the owner automatically.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
