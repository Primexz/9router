import { NextResponse } from "next/server";
import { getPerformanceDashboard } from "@/lib/db/repos/performanceRepo.js";
import { PERFORMANCE_PERIODS } from "@/lib/performanceMetrics.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const period = params.get("period") || "24h";
  if (!PERFORMANCE_PERIODS.includes(period)) return NextResponse.json({ error: "Invalid period" }, { status: 400 });
  const filters = { period };
  for (const field of ["provider", "model", "connectionId"]) {
    const value = params.get(field) || "";
    if (value.length > 256) return NextResponse.json({ error: "Invalid filter" }, { status: 400 });
    filters[field] = value;
  }
  try {
    return NextResponse.json(await getPerformanceDashboard(filters), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[API] Failed to load performance metrics:", error);
    return NextResponse.json({ error: "Failed to load performance metrics" }, { status: 500 });
  }
}
