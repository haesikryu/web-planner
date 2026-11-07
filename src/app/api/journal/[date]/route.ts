import { calendarDate } from "@/domain/rules";
import { authenticated, expectedVersion, readJson, requestKey, respond } from "@/server/product/http";
import { getJournal, putJournal } from "@/server/product/journal";

export const runtime = "nodejs";
type Context = { params: Promise<{ date: string }> };
export async function GET(request: Request, context: Context) {
  return authenticated(request, false, async actor => respond(await getJournal(actor, calendarDate((await context.params).date))));
}
export async function PUT(request: Request, context: Context) {
  return authenticated(request, true, async actor => respond(await putJournal(actor, calendarDate((await context.params).date), requestKey(request), expectedVersion(request, true), await readJson(request, 65536))));
}
