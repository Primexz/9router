import { NextResponse } from "next/server";
import { getTokenActivity } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getTokenActivity(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[API] Failed to get token activity:", error);
    return NextResponse.json({ error: "Failed to fetch token activity" }, { status: 500 });
  }
}
