"use client";

import { type FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export function InstanceNameEditor({ instanceId, name }: { instanceId: string; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setDialogOpen(nextOpen: boolean) {
    if (nextOpen) {
      setDraft(name);
      setError(null);
    }
    setOpen(nextOpen);
  }

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/instances/${encodeURIComponent(instanceId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: draft }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not rename instance");
      setOpen(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not rename instance");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button variant="ghost" size="icon-xs" onClick={() => setDialogOpen(true)} aria-label={`Rename ${name}`} title="Rename instance">
        <Pencil className="size-3" />
      </Button>
      <Dialog open={open} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename instance</DialogTitle>
            <DialogDescription>This changes the dashboard name only. The server address and running process stay unchanged.</DialogDescription>
          </DialogHeader>
          <form onSubmit={rename} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="instanceName" className="text-sm font-medium">Name</label>
              <Input
                id="instanceName"
                value={draft}
                onChange={(event) => setDraft(event.currentTarget.value)}
                maxLength={80}
                autoFocus
                disabled={pending}
              />
            </div>
            {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
              <Button type="submit" disabled={pending || !draft.trim() || draft.trim() === name}>
                {pending && <Loader2 className="size-4 animate-spin" />}Save name
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
