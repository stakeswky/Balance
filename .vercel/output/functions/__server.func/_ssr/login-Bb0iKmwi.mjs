import { b as require_jsx_runtime, v as Link } from "../_libs/@tanstack/react-router+[...].mjs";
import { r as signIn } from "./client-sGid3STf.mjs";
import { t as GROK_PROVIDERS } from "./server-PDM6ERpB.mjs";
import { t as Button } from "./button-Te5z8_1T.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/login-Bb0iKmwi.js
var import_jsx_runtime = require_jsx_runtime();
function Login() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("main", {
		className: "grid min-h-dvh place-items-center bg-canvas px-4 text-ink",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "w-full max-w-sm",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
					to: "/",
					className: "text-xs text-mute no-underline hover:text-ink",
					children: "返回监控"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
					className: "mt-6 text-2xl font-medium tracking-tight",
					children: "登录 Synq"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "mt-2 text-sm leading-relaxed text-mute",
					children: "套餐选择会同步到你的账号。未登录也能在本机预览里完整使用监控。"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "mt-6 space-y-2",
					children: GROK_PROVIDERS.map((p) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Button, {
						type: "button",
						variant: "secondary",
						className: "w-full",
						onClick: () => signIn(p.providerId, { callbackURL: "/" }),
						children: [
							"使用 ",
							p.label,
							" 继续"
						]
					}, p.providerId))
				})
			]
		})
	});
}
//#endregion
export { Login as component };
