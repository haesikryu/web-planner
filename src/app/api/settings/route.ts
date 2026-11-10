import { and, eq } from "drizzle-orm";
import { object, timezone } from "@/domain/rules";
import { user } from "@/server/db/schema";
import { authenticated, etag, expectedVersion, HttpError, readJson, requestKey, respond } from "@/server/product/http";
import { writeOnce } from "@/server/product/write";

export const runtime = "nodejs";
export async function PATCH(request: Request) {
  return authenticated(request, true, async actor => {
    const body = object(await readJson(request), ["timezone"]), zone = timezone(body.timezone);
    const version = expectedVersion(request), key = requestKey(request);
    return respond(await writeOnce(actor.id, "PATCH", "/api/settings", key, { timezone: zone, version }, async tx => {
      const [current] = await tx.select().from(user).where(eq(user.id, actor.id)).for("update");
      if (!current || current.settingsVersion !== version) throw new HttpError(412, "VERSION_CONFLICT", "설정이 변경되었습니다. 최신 내용을 확인해주세요.");
      if (current.timezone === zone) return { status: 200, body: { timezone: zone, version }, etag: etag(version) };
      const [updated] = await tx.update(user).set({ timezone: zone, settingsVersion: version + 1, updatedAt: new Date() })
        .where(and(eq(user.id, actor.id), eq(user.settingsVersion, version))).returning();
      if (!updated) throw new HttpError(412, "VERSION_CONFLICT", "최신 설정을 확인해주세요.");
      return { status: 200, body: { timezone: updated.timezone, version: updated.settingsVersion }, etag: etag(updated.settingsVersion) };
    }));
  });
}
