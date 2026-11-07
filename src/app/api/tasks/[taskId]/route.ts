import { authenticated, expectedVersion, readJson, requestKey, respond } from "@/server/product/http";
import { getTask, patchTask, taskId } from "@/server/product/tasks";

export const runtime = "nodejs";
type Context = { params: Promise<{ taskId: string }> };
export async function GET(request: Request, context: Context) {
  return authenticated(request, false, async actor => respond(await getTask(actor, taskId((await context.params).taskId))));
}
export async function PATCH(request: Request, context: Context) {
  return authenticated(request, true, async actor => respond(await patchTask(actor, taskId((await context.params).taskId), requestKey(request), expectedVersion(request), await readJson(request))));
}
