import { i as createServerFn, t as TSS_SERVER_FUNCTION } from "./ssr.mjs";
import { r as getSql } from "./db-DYR681Oo.mjs";
import { t as authMiddleware } from "./middleware-Cmww-KSA.mjs";
import { _n as string, mn as object, pn as number } from "../_libs/@better-auth/core+[...].mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/actions-_GGlmiaX.js
var createServerRpc = (serverFnMeta, splitImportFn) => {
	const url = "/_serverFn/" + serverFnMeta.id;
	return Object.assign(splitImportFn, {
		url,
		serverFnMeta,
		[TSS_SERVER_FUNCTION]: true
	});
};
var settingsSchema = object({
	claudePlanId: string(),
	codexPlanId: string(),
	weekBoostPct: number().min(0).max(100)
});
var loadSettings_createServerFn_handler = createServerRpc({
	id: "c014ba2c2d4b43d226a4131745e146d1bbf0a623f4cb52fb11f6bf0ba1f3e518",
	name: "loadSettings",
	filename: "src/lib/quota/actions.ts"
}, (opts) => loadSettings.__executeServer(opts));
var loadSettings = createServerFn({ method: "GET" }).middleware([authMiddleware]).handler(loadSettings_createServerFn_handler, async ({ context }) => {
	const row = (await (await getSql())`select claude_plan, codex_plan, week_boost_pct from synq_settings where user_id = ${context.userId}`)[0];
	if (!row) return null;
	return {
		claudePlanId: row.claude_plan,
		codexPlanId: row.codex_plan,
		weekBoostPct: row.week_boost_pct
	};
});
var saveSettings_createServerFn_handler = createServerRpc({
	id: "d811944b1a16441d70a516832a15ee7b8d1c2547790c84997eb34fbe38c3f484",
	name: "saveSettings",
	filename: "src/lib/quota/actions.ts"
}, (opts) => saveSettings.__executeServer(opts));
var saveSettings = createServerFn({ method: "POST" }).middleware([authMiddleware]).validator((data) => settingsSchema.parse(data)).handler(saveSettings_createServerFn_handler, async ({ context, data }) => {
	await (await getSql())`
      insert into synq_settings (user_id, claude_plan, codex_plan, week_boost_pct, updated_at)
      values (${context.userId}, ${data.claudePlanId}, ${data.codexPlanId}, ${data.weekBoostPct}, now())
      on conflict (user_id) do update set
        claude_plan = excluded.claude_plan,
        codex_plan = excluded.codex_plan,
        week_boost_pct = excluded.week_boost_pct,
        updated_at = now()
    `;
	return { ok: true };
});
//#endregion
export { loadSettings_createServerFn_handler, saveSettings_createServerFn_handler };
