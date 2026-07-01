import { NextResponse } from "next/server";
import { requireMember } from "@/lib/auth";

export async function GET() {
  await requireMember();
  return NextResponse.json({
    mode: process.env.BLOB_READ_WRITE_TOKEN
      ? "blob"
      : process.env.HOMESHARD_LOCAL_STAGING_DIR
        ? "local"
        : "none",
    maximumSizeBytes: 250 * 1024 * 1024,
  });
}
