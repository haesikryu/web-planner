import { authenticated, readJson, requestKey, respond } from "@/server/product/http";
import { createTask, listTasks } from "@/server/product/tasks";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return authenticated(request, false, async actor => respond(await listTasks(actor, new URL(request.url))));
}
export async function POST(request: Request) {
  return authenticated(request, true, async actor => respond(await createTask(actor, requestKey(request), await readJson(request))));
}
