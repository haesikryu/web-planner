export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { status: "ok", service: "web-planner" },
    { headers: { "Cache-Control": "no-store" } }
  );
}
