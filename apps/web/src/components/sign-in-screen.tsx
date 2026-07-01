"use client";

import { SignIn } from "@clerk/nextjs";
import { LockKeyhole } from "lucide-react";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function SignInScreen() {
  if (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return (
      <main className="grid min-h-screen place-items-center p-6">
        <SignIn />
      </main>
    );
  }

  return (
    <main className="grid min-h-screen place-items-center p-6">
      <Card className="max-w-lg border-border/70 bg-card/85">
        <CardHeader>
          <div className="mb-4 w-fit rounded-xl bg-primary/15 p-3 text-primary">
            <LockKeyhole className="size-6" />
          </div>
          <CardTitle>Authentication is not configured</CardTitle>
          <CardDescription>
            Add Clerk keys to enable sign-in. Local demo mode signs in as the owner automatically.
          </CardDescription>
        </CardHeader>
      </Card>
    </main>
  );
}
