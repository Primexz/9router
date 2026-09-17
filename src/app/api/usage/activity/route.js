import { NextResponse } from "next/server";
import { getTokenActivity } from "@/lib/usageDb";
import { getSettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { timeZone } = await getSettings();
    return NextResponse.json(await getTokenActivity(timeZone), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[API] Failed to get token activity:", error);
    return NextResponse.json({ error: "Failed to fetch token activity" }, { status: 500 });
  }
}
