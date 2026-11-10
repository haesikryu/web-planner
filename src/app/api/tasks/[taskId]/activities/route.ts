import { authenticated, respond } from "@/server/product/http";
import { listTaskActivities, taskId } from "@/server/product/tasks";

export const runtime = "nodejs";
type Context = { params: Promise<{ taskId: string }> };
export async function GET(request: Request, context: Context) {
  return authenticated(request, false, async actor => respond(await listTaskActivities(actor, taskId((await context.params).taskId), new URL(request.url))));
}
