import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { z } from "zod";

const settingsSchema = z.object({
  claudePlanId: z.string(),
  codexPlanId: z.string(),
  weekBoostPct: z.number().min(0).max(100),
});

export const loadSettings = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const rows = await sql<{
      claude_plan: string;
      codex_plan: string;
      week_boost_pct: number;
    }>`select claude_plan, codex_plan, week_boost_pct from balance_settings where user_id = ${context.userId}`;
    const row = rows[0];
    if (!row) return null;
    return {
      claudePlanId: row.claude_plan,
      codexPlanId: row.codex_plan,
      weekBoostPct: row.week_boost_pct,
    };
  });

export const saveSettings = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: unknown) => settingsSchema.parse(data))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await sql`
      insert into balance_settings (user_id, claude_plan, codex_plan, week_boost_pct, updated_at)
      values (${context.userId}, ${data.claudePlanId}, ${data.codexPlanId}, ${data.weekBoostPct}, now())
      on conflict (user_id) do update set
        claude_plan = excluded.claude_plan,
        codex_plan = excluded.codex_plan,
        week_boost_pct = excluded.week_boost_pct,
        updated_at = now()
    `;
    return { ok: true as const };
  });
