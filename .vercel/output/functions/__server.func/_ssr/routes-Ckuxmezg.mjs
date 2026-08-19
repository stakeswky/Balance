import { o as __toESM } from "../_runtime.mjs";
import { n as require_react } from "../_libs/@radix-ui/react-compose-refs+[...].mjs";
import { b as require_jsx_runtime, v as Link } from "../_libs/@tanstack/react-router+[...].mjs";
import { i as createServerFn, o as getServerFnById, t as TSS_SERVER_FUNCTION } from "./ssr.mjs";
import { t as authMiddleware } from "./middleware-Cmww-KSA.mjs";
import { _n as string, mn as object, pn as number } from "../_libs/@better-auth/core+[...].mjs";
import { i as signOut, t as authClient } from "./client-sGid3STf.mjs";
import { t as cva } from "../_libs/class-variance-authority+clsx.mjs";
import { n as cn, t as Button } from "./button-Te5z8_1T.mjs";
import { i as Pause, n as RotateCcw, r as Play } from "../_libs/lucide-react.mjs";
import { n as toast, t as Toaster } from "../_libs/sonner.mjs";
import { n as create, t as persist } from "../_libs/zustand.mjs";
import { a as ResponsiveContainer, i as Area, n as YAxis, o as Tooltip, r as XAxis, t as AreaChart } from "../_libs/recharts+[...].mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/routes-Ckuxmezg.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
var badgeVariants = cva("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium", {
	variants: { tone: {
		mute: "bg-raised text-mute",
		ok: "bg-ok/15 text-ok",
		watch: "bg-warn/15 text-warn",
		critical: "bg-crit/15 text-crit",
		claude: "bg-claude-dim text-claude",
		codex: "bg-codex-dim text-codex"
	} },
	defaultVariants: { tone: "mute" }
});
function Badge({ className, tone, ...props }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
		className: cn(badgeVariants({
			tone,
			className
		})),
		...props
	});
}
function Card({ className, ...props }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: cn("rounded-2xl bg-surface p-4 shadow-[var(--shadow-border)] sm:p-5", className),
		...props
	});
}
function CardHeader({ className, ...props }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: cn("mb-4 flex items-start justify-between gap-3", className),
		...props
	});
}
function CardTitle({ className, ...props }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
		className: cn("text-sm font-medium tracking-tight text-ink", className),
		...props
	});
}
function CardHint({ className, ...props }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
		className: cn("text-xs text-mute", className),
		...props
	});
}
var CLAUDE_PLANS = [
	{
		id: "claude-pro",
		agent: "claude",
		name: "Claude Pro",
		priceUsd: 20,
		blurb: "约 4.4 万加权 token / 5 小时，适合偶尔的深度会话。",
		windowTokenBudget: 44e3,
		weekTokenBudget: 44e4,
		windowReasoningMin: 0,
		weekReasoningMin: 0,
		kind: "subscription"
	},
	{
		id: "claude-max-5x",
		agent: "claude",
		name: "Claude Max 5×",
		priceUsd: 100,
		blurb: "约 8.8 万加权 token / 5 小时，日常主力开发档。",
		windowTokenBudget: 88e3,
		weekTokenBudget: 22e5,
		windowReasoningMin: 0,
		weekReasoningMin: 0,
		kind: "subscription"
	},
	{
		id: "claude-max-20x",
		agent: "claude",
		name: "Claude Max 20×",
		priceUsd: 200,
		blurb: "约 22 万加权 token / 5 小时，全天 Agent 不中断。",
		windowTokenBudget: 22e4,
		weekTokenBudget: 88e5,
		windowReasoningMin: 0,
		weekReasoningMin: 0,
		kind: "subscription"
	},
	{
		id: "claude-api",
		agent: "claude",
		name: "Anthropic API",
		priceUsd: 0,
		blurb: "按量计费，无 5 小时窗；额度按本周 API 成本估算。",
		windowTokenBudget: 2e6,
		weekTokenBudget: 8e6,
		windowReasoningMin: 0,
		weekReasoningMin: 0,
		kind: "api"
	}
];
var CODEX_PLANS = [
	{
		id: "chatgpt-plus",
		agent: "codex",
		name: "ChatGPT Plus",
		priceUsd: 20,
		blurb: "约 40 分钟推理 / 5 小时窗，外加周额度。",
		windowTokenBudget: 18e4,
		weekTokenBudget: 12e5,
		windowReasoningMin: 40,
		weekReasoningMin: 180,
		kind: "subscription"
	},
	{
		id: "chatgpt-pro",
		agent: "codex",
		name: "ChatGPT Pro",
		priceUsd: 200,
		blurb: "约 5× Plus 窗口，适合全天 Codex CLI。",
		windowTokenBudget: 9e5,
		weekTokenBudget: 6e6,
		windowReasoningMin: 200,
		weekReasoningMin: 900,
		kind: "subscription"
	},
	{
		id: "chatgpt-team",
		agent: "codex",
		name: "ChatGPT Business",
		priceUsd: 30,
		blurb: "席位制，窗口介于 Plus 与 Pro 之间。",
		windowTokenBudget: 36e4,
		weekTokenBudget: 24e5,
		windowReasoningMin: 80,
		weekReasoningMin: 360,
		kind: "subscription"
	},
	{
		id: "openai-api",
		agent: "codex",
		name: "OpenAI API",
		priceUsd: 0,
		blurb: "按量计费 + 可选额度包，无订阅窗。",
		windowTokenBudget: 2e6,
		weekTokenBudget: 1e7,
		windowReasoningMin: 600,
		weekReasoningMin: 3e3,
		kind: "api"
	}
];
var ALL_PLANS = [...CLAUDE_PLANS, ...CODEX_PLANS];
function planById(id) {
	const found = ALL_PLANS.find((p) => p.id === id);
	if (!found) throw new Error(`Unknown plan: ${id}`);
	return found;
}
var MODEL_META = {
	opus: {
		label: "Opus 4.7",
		agent: "claude",
		weight: 5,
		inPerM: 15,
		outPerM: 75
	},
	sonnet: {
		label: "Sonnet 4.6",
		agent: "claude",
		weight: 1,
		inPerM: 3,
		outPerM: 15
	},
	haiku: {
		label: "Haiku 4.5",
		agent: "claude",
		weight: .2,
		inPerM: 1,
		outPerM: 5
	},
	"gpt-5.4": {
		label: "GPT-5.4",
		agent: "codex",
		weight: 2.2,
		inPerM: 10,
		outPerM: 30
	},
	"gpt-5.3-codex": {
		label: "GPT-5.3 Codex",
		agent: "codex",
		weight: 1,
		inPerM: 5,
		outPerM: 15
	},
	"gpt-5-codex-mini": {
		label: "Codex Mini",
		agent: "codex",
		weight: .35,
		inPerM: 1.5,
		outPerM: 6
	}
};
var CACHE_READ_FACTOR = .1;
var CACHE_WRITE_FACTOR = 1.25;
var WINDOW_MS = 18e6;
var WEEK_MS = 6048e5;
function weightedTokens(event) {
	const meta = MODEL_META[event.model];
	return (event.tokensIn + event.tokensOut + event.cacheRead * CACHE_READ_FACTOR + event.cacheWrite * CACHE_WRITE_FACTOR) * meta.weight;
}
function rawTokens(event) {
	return event.tokensIn + event.tokensOut + event.cacheRead + event.cacheWrite;
}
function apiUsd(event) {
	const meta = MODEL_META[event.model];
	return (event.tokensIn + event.cacheWrite * CACHE_WRITE_FACTOR + event.cacheRead * CACHE_READ_FACTOR) / 1e6 * meta.inPerM + event.tokensOut / 1e6 * meta.outPerM;
}
function inWindow(events, now, span, agent) {
	const from = now - span;
	return events.filter((e) => e.ts >= from && e.ts <= now && (agent ? e.agent === agent : true));
}
function clampPct(n) {
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(140, n));
}
function eventWindowShare(event, plan) {
	if (plan.agent === "codex" && plan.windowReasoningMin > 0) {
		const reason = event.reasoningMin / plan.windowReasoningMin * 100;
		const tok = weightedTokens(event) / plan.windowTokenBudget * 100;
		return reason * .72 + tok * .28;
	}
	return weightedTokens(event) / plan.windowTokenBudget * 100;
}
function eventWeekShare(event, plan, boostPct) {
	const boost = 1 + Math.max(0, boostPct) / 100;
	if (plan.agent === "codex" && plan.weekReasoningMin > 0) {
		const reason = event.reasoningMin / (plan.weekReasoningMin * boost) * 100;
		const tok = weightedTokens(event) / (plan.weekTokenBudget * boost) * 100;
		return reason * .72 + tok * .28;
	}
	return weightedTokens(event) / (plan.weekTokenBudget * boost) * 100;
}
function meterFor(events, agent, plan, now, boostPct) {
	const win = inWindow(events, now, WINDOW_MS, agent);
	const week = inWindow(events, now, WEEK_MS, agent);
	const windowPct = clampPct(win.reduce((s, e) => s + eventWindowShare(e, plan), 0));
	const weekPct = clampPct(week.reduce((s, e) => s + eventWeekShare(e, plan, boostPct), 0));
	const windowTokens = win.reduce((s, e) => s + rawTokens(e), 0);
	const weekTokens = week.reduce((s, e) => s + rawTokens(e), 0);
	const windowReasoningMin = win.reduce((s, e) => s + e.reasoningMin, 0);
	const weekReasoningMin = week.reduce((s, e) => s + e.reasoningMin, 0);
	const recent = win.filter((e) => e.ts >= now - 27e5);
	const recentPct = recent.reduce((s, e) => s + eventWindowShare(e, plan), 0);
	const burnPctPerHour = recent.length ? recentPct / 45 * 60 : 0;
	const remain = Math.max(0, 100 - windowPct);
	const etaMs = burnPctPerHour > .4 ? remain / burnPctPerHour * 60 * 60 * 1e3 : null;
	let status = "ok";
	if (windowPct >= 88 || weekPct >= 88) status = "critical";
	else if (windowPct >= 68 || weekPct >= 72) status = "watch";
	const oldest = win.reduce((min, e) => Math.min(min, e.ts), now);
	const windowResetsAt = win.length ? oldest + WINDOW_MS : now + WINDOW_MS;
	return {
		agent,
		windowPct,
		weekPct,
		windowTokens,
		weekTokens,
		windowReasoningMin,
		weekReasoningMin,
		windowBudget: plan.windowTokenBudget,
		weekBudget: plan.weekTokenBudget * (1 + Math.max(0, boostPct) / 100),
		windowResetsAt,
		weekResetsAt: now - now % 864e5 + WEEK_MS,
		burnPctPerHour,
		etaMs,
		apiUsdWindow: win.reduce((s, e) => s + apiUsd(e), 0),
		apiUsdWeek: week.reduce((s, e) => s + apiUsd(e), 0),
		status
	};
}
function modelShares(events, agent, now, span) {
	const slice = inWindow(events, now, span, agent);
	const byModel = /* @__PURE__ */ new Map();
	let total = 0;
	for (const e of slice) {
		const t = rawTokens(e);
		total += t;
		const cur = byModel.get(e.model) ?? {
			tokens: 0,
			events: 0
		};
		cur.tokens += t;
		cur.events += 1;
		byModel.set(e.model, cur);
	}
	return [...byModel.entries()].map(([model, v]) => ({
		model,
		tokens: v.tokens,
		events: v.events,
		pct: total ? v.tokens / total * 100 : 0
	})).sort((a, b) => b.tokens - a.tokens);
}
function hourlySeries(events, now, hours) {
	const buckets = [];
	const hour = 36e5;
	for (let i = hours - 1; i >= 0; i--) {
		const end = now - i * hour;
		const start = end - hour;
		const slice = events.filter((e) => e.ts > start && e.ts <= end);
		const claude = slice.filter((e) => e.agent === "claude").reduce((s, e) => s + rawTokens(e), 0);
		const codex = slice.filter((e) => e.agent === "codex").reduce((s, e) => s + rawTokens(e), 0);
		const d = new Date(end);
		buckets.push({
			t: end,
			claude,
			codex,
			label: `${d.getHours().toString().padStart(2, "0")}:00`
		});
	}
	return buckets;
}
function formatTokens(n) {
	if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
	if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return Math.round(n).toString();
}
function formatUsd(n) {
	if (n >= 100) return `$${n.toFixed(0)}`;
	if (n >= 10) return `$${n.toFixed(1)}`;
	return `$${n.toFixed(2)}`;
}
function formatDuration(ms) {
	if (ms < 0) return "—";
	const m = Math.round(ms / 6e4);
	if (m < 60) return `${m} 分钟`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	if (h < 24) return rm ? `${h} 小时 ${rm} 分` : `${h} 小时`;
	return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}
function modelLabel(id) {
	return MODEL_META[id].label;
}
function MeterBar({ value, tone, label }) {
	const width = Math.max(0, Math.min(100, value));
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-1.5",
		children: [label ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-baseline justify-between text-xs",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
				className: "text-mute",
				children: label
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
				className: "tabular font-mono text-ink",
				children: [width.toFixed(width >= 10 ? 0 : 1), "%"]
			})]
		}) : null, /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
			className: "h-1.5 overflow-hidden rounded-full bg-raised",
			children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: cn("meter-fill h-full rounded-full", tone === "claude" && "bg-claude", tone === "codex" && "bg-codex", tone === "ok" && "bg-ok", tone === "warn" && "bg-warn", tone === "crit" && "bg-crit"),
				style: { width: `${width}%` }
			})
		})]
	});
}
var statusCopy = {
	ok: "充足",
	watch: "留意",
	critical: "将尽"
};
function AgentCard({ name, adapter, plan, meter, session, live, events, now, onToggle }) {
	const tone = meter.agent;
	const shares = modelShares(events, meter.agent, now, WEEK_MS);
	const remain = Math.max(0, 100 - meter.windowPct);
	const weighted = inWindow(events, now, WINDOW_MS, meter.agent).reduce((s, e) => s + weightedTokens(e), 0);
	const barTone = meter.status === "critical" ? "crit" : meter.status === "watch" ? "warn" : tone;
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Card, { children: [
		/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(CardHeader, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "flex flex-wrap items-center gap-2",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: cn("size-1.5 rounded-full", live ? "bg-ok" : "bg-faint") }),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(CardTitle, { children: name }),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
					tone: meter.status,
					children: statusCopy[meter.status]
				})
			]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(CardHint, {
			className: "mt-1",
			children: [
				plan.name,
				" · ",
				adapter
			]
		})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Button, {
			variant: "secondary",
			size: "sm",
			onClick: onToggle,
			"aria-pressed": live,
			children: [live ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Pause, {}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Play, {}), live ? "暂停" : "采集"]
		})] }),
		/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "flex items-end justify-between gap-4",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "text-xs text-mute",
				children: "窗口剩余"
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
				className: "mt-1 font-mono text-4xl leading-none font-medium tracking-tight tabular",
				children: [remain.toFixed(0), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
					className: "ml-1 text-lg text-mute",
					children: "%"
				})]
			})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "text-right text-xs text-mute",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { children: [
					"燃烧 ",
					meter.burnPctPerHour.toFixed(1),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "text-faint",
						children: " %/时"
					})
				] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "mt-1",
					children: meter.etaMs != null && meter.etaMs < 216e5 ? `预计 ${formatDuration(meter.etaMs)} 耗尽` : "当前速率可撑过本窗"
				})]
			})]
		}),
		/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "mt-5 space-y-3",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(MeterBar, {
				value: meter.windowPct,
				tone: barTone === "crit" || barTone === "warn" ? barTone : tone,
				label: "5 小时窗"
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MeterBar, {
				value: meter.weekPct,
				tone: meter.weekPct >= 88 ? "crit" : meter.weekPct >= 72 ? "warn" : tone,
				label: "本周额度"
			})]
		}),
		/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("dl", {
			className: "mt-5 grid grid-cols-2 gap-3 text-xs",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stat, {
					label: "本窗 token",
					value: formatTokens(meter.windowTokens)
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stat, {
					label: meter.agent === "codex" ? "本窗推理" : "加权用量",
					value: meter.agent === "codex" ? `${meter.windowReasoningMin.toFixed(1)} 分` : formatTokens(weighted)
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stat, {
					label: "本周 token",
					value: formatTokens(meter.weekTokens)
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Stat, {
					label: "等价 API",
					value: formatUsd(meter.apiUsdWeek)
				})
			]
		}),
		session && live ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "mt-5 rounded-md bg-raised px-3 py-3",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "text-[11px] tracking-wide text-faint uppercase",
					children: "实时会话"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "mt-1 text-sm text-ink",
					children: session.task
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
					className: "mt-1 font-mono text-xs text-mute",
					children: [
						modelLabel(session.model),
						" · ",
						session.events,
						" 轮 · ",
						formatTokens(session.tokens)
					]
				})
			]
		}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
			className: "mt-5 rounded-md bg-raised px-3 py-3 text-sm text-mute",
			children: "采集已暂停"
		}),
		/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
			className: "mt-4 space-y-2",
			children: shares.length ? shares.map((s) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center gap-3 text-xs",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "w-28 truncate text-mute",
						children: modelLabel(s.model)
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "h-1 flex-1 overflow-hidden rounded-full bg-raised",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: cn("h-full rounded-full", tone === "claude" ? "bg-claude" : "bg-codex"),
							style: { width: `${s.pct}%` }
						})
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
						className: "w-10 text-right font-mono tabular text-ink",
						children: [s.pct.toFixed(0), "%"]
					})
				]
			}, s.model)) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "text-xs text-mute",
				children: "本周尚无模型拆分"
			})
		})
	] });
}
function Stat({ label, value }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "rounded-md bg-raised px-3 py-2.5",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
			className: "text-faint",
			children: label
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", {
			className: "mt-1 font-mono text-sm text-ink tabular",
			children: value
		})]
	});
}
function timeLabel(ts, now) {
	const delta = now - ts;
	if (delta < 6e4) return "刚刚";
	if (delta < 36e5) return `${Math.floor(delta / 6e4)} 分钟前`;
	const d = new Date(ts);
	return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}
function EventFeed({ events, now }) {
	const latest = [...events].sort((a, b) => b.ts - a.ts).slice(0, 14);
	if (!latest.length) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
		className: "text-sm text-mute",
		children: "还没有用量事件。打开协同采集，或导入会话日志。"
	});
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", {
		className: "divide-y divide-line",
		children: latest.map((e) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
			className: "flex items-start gap-3 py-3 first:pt-0 last:pb-0",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: cn("mt-1.5 size-1.5 shrink-0 rounded-full", e.agent === "claude" ? "bg-claude" : "bg-codex") }),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "min-w-0 flex-1",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "truncate text-sm text-ink",
						children: e.task
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
						className: "mt-0.5 font-mono text-xs text-mute",
						children: [
							e.agent === "claude" ? "Claude Code" : "Codex",
							" · ",
							modelLabel(e.model),
							" ·",
							" ",
							formatTokens(rawTokens(e)),
							e.reasoningMin > 0 ? ` · ${e.reasoningMin.toFixed(1)} 分推理` : ""
						]
					})]
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("time", {
					className: "shrink-0 font-mono text-[11px] text-faint tabular",
					children: timeLabel(e.ts, now)
				})
			]
		}, e.id))
	});
}
/**
* Current user + loading state. Same behavior in live preview and when deployed:
*   - Auth enabled (default) -> the real signed-in user; `user` is `null` while
*                            the session resolves (`isPending: true`) and when
*                            signed out (`isPending: false`). Session comes from
*                            Better Auth `useSession()` → `/api/auth/get-session`
*                            (cookie when deployed; bearer in live preview).
*   - Auth disabled (`VITE_AUTH_ENABLED=false`) -> `DEV_USER`, never pending.
*
* Protect a route by waiting out `isPending` before acting on `user` —
* redirecting on `user: null` alone bounces signed-in visitors to sign-in on
* every hard reload:
*
*   import { RedirectToSignIn } from "@/lib/auth/gates";
*   const { user, isPending } = useCurrentUserState();
*   if (isPending) return null;              // still resolving — don't redirect yet
*   if (!user) return <RedirectToSignIn />;  // definitely signed out
*
* `authEnabled` is a module-level constant fixed at load, so the guarded hook
* call keeps a stable hook order across every render of a given component.
*/
function useCurrentUserState() {
	const { data, isPending } = authClient.useSession();
	const user = data?.user;
	return {
		user: user ? {
			id: user.id,
			displayName: user.name ?? null,
			primaryEmail: user.email ?? null,
			profileImageUrl: user.image ?? null,
			isDevFallback: false
		} : null,
		isPending
	};
}
var NAV = [
	{
		id: "monitor",
		label: "监控"
	},
	{
		id: "plans",
		label: "套餐"
	},
	{
		id: "plugin",
		label: "插件"
	}
];
function Header({ view, onView, live }) {
	const { user, isPending } = useCurrentUserState();
	const label = user?.displayName ?? user?.primaryEmail ?? "账号";
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("header", {
		className: "sticky top-0 z-40 border-b border-line bg-canvas/85 backdrop-blur-md",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Link, {
					to: "/",
					className: "flex items-center gap-2.5 text-ink no-underline",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "grid size-8 place-items-center rounded-md bg-raised shadow-[var(--shadow-border)]",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", {
							viewBox: "0 0 24 24",
							className: "size-4",
							"aria-hidden": true,
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", {
								d: "M4 16a8 8 0 0 1 16 0",
								fill: "none",
								stroke: "currentColor",
								className: "text-claude",
								strokeWidth: "1.8",
								strokeLinecap: "round"
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", {
								d: "M8 16a4 4 0 0 1 8 0",
								fill: "none",
								stroke: "currentColor",
								className: "text-codex",
								strokeWidth: "1.8",
								strokeLinecap: "round"
							})]
						})
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
						className: "leading-tight",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
							className: "block text-sm font-medium tracking-tight",
							children: "Synq"
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
							className: "hidden text-[11px] text-mute sm:block",
							children: "双 Agent 额度"
						})]
					})]
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("nav", {
					className: "ml-1 flex items-center rounded-lg bg-surface p-1 shadow-[var(--shadow-border)] sm:ml-2",
					children: NAV.map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: () => onView(item.id),
						className: cn("h-9 rounded-md px-2.5 text-sm transition-colors duration-150 sm:px-3", view === item.id ? "bg-raised text-ink" : "text-mute hover:text-ink"),
						children: item.label
					}, item.id))
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "ml-auto flex items-center gap-3",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
						className: "hidden items-center gap-1.5 text-xs text-mute md:flex",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: cn("size-1.5 rounded-full", live ? "bg-ok" : "bg-faint") }), live ? "协同采集中" : "采集已暂停"]
					}), isPending ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "size-8 animate-pulse rounded-full bg-raised" }) : user ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-center gap-2",
						children: [
							user.profileImageUrl ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("img", {
								src: user.profileImageUrl,
								alt: "",
								className: "size-8 rounded-full object-cover outline outline-1 -outline-offset-1 outline-ink/10"
							}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
								className: "grid size-8 place-items-center rounded-full bg-raised text-xs font-medium",
								children: label.charAt(0).toUpperCase()
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
								className: "hidden max-w-28 truncate text-sm sm:inline",
								children: label
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: () => void signOut(),
								className: "text-xs text-mute hover:text-ink",
								children: "退出"
							})
						]
					}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
						to: "/login",
						className: "inline-flex h-11 items-center rounded-md bg-raised px-3 text-sm text-ink no-underline shadow-[var(--shadow-border)] hover:shadow-[var(--shadow-border-hover)]",
						children: "登录"
					})]
				})
			]
		})
	});
}
function PlanList({ title, plans, selected, onSelect }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", {
		className: "mb-3 text-sm font-medium",
		children: title
	}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "grid gap-2",
		children: plans.map((p) => {
			const active = p.id === selected;
			return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
				type: "button",
				onClick: () => onSelect(p.id),
				className: cn("rounded-xl p-4 text-left shadow-[var(--shadow-border)] transition-[box-shadow,background-color] duration-150", active ? "bg-raised shadow-[var(--shadow-border-hover)]" : "bg-surface hover:bg-raised"),
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "flex items-baseline justify-between gap-3",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
							className: "text-sm font-medium",
							children: p.name
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
							className: "font-mono text-xs text-mute",
							children: p.kind === "api" ? "按量" : `$${p.priceUsd}/月`
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "mt-1 text-xs leading-relaxed text-mute",
						children: p.blurb
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
						className: "mt-2 font-mono text-[11px] text-faint",
						children: [
							"窗 ",
							formatTokens(p.windowTokenBudget),
							p.windowReasoningMin ? ` · ${p.windowReasoningMin} 分推理` : ""
						]
					})
				]
			}, p.id);
		})
	})] });
}
function PlansPanel({ claudePlanId, codexPlanId, weekBoostPct, onClaude, onCodex, onBoost }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "grid gap-5 lg:grid-cols-2",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(PlanList, {
				title: "Claude Code 套餐",
				plans: CLAUDE_PLANS,
				selected: claudePlanId,
				onSelect: onClaude
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(PlanList, {
				title: "Codex 套餐",
				plans: CODEX_PLANS,
				selected: codexPlanId,
				onSelect: onCodex
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Card, {
				className: "lg:col-span-2",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "flex flex-wrap items-start justify-between gap-3",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(CardTitle, { children: "周额度加成" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(CardHint, {
							className: "mt-1",
							children: "Anthropic 目前对 Pro / Max / Team 提供临时周额度上浮。默认按 50% 计算至 8 月底。"
						})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Badge, {
							tone: "mute",
							children: [weekBoostPct, "%"]
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
						type: "range",
						min: 0,
						max: 100,
						step: 10,
						value: weekBoostPct,
						onChange: (e) => onBoost(Number(e.target.value)),
						className: "mt-5 w-full accent-accent",
						"aria-label": "周额度加成百分比"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "mt-2 flex justify-between font-mono text-[11px] text-faint",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "0%" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "50%" }),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "100%" })
						]
					})
				]
			})
		]
	});
}
function Textarea({ className, ...props }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", {
		className: cn("min-h-36 w-full rounded-lg bg-raised p-3 font-mono text-xs leading-relaxed text-ink shadow-[var(--shadow-border)] placeholder:text-faint", className),
		...props
	});
}
function asModel(raw, agent) {
	const s = raw.toLowerCase();
	if (agent === "claude") {
		if (s.includes("opus")) return "opus";
		if (s.includes("haiku")) return "haiku";
		return "sonnet";
	}
	if (s.includes("mini")) return "gpt-5-codex-mini";
	if (s.includes("5.4") || s.includes("o3")) return "gpt-5.4";
	return "gpt-5.3-codex";
}
function num(v) {
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? n : 0;
}
function parseOne(raw, fallbackAgent, index) {
	if (!raw || typeof raw !== "object") return null;
	const o = raw;
	const msg = o.message ?? o;
	const usage = o.usage ?? msg.usage ?? o.token_usage ?? {};
	const agentRaw = String(o.agent ?? o.source ?? fallbackAgent).toLowerCase();
	const agent = agentRaw.includes("codex") || agentRaw.includes("openai") ? "codex" : "claude";
	const modelRaw = String(o.model ?? msg.model ?? (agent === "claude" ? "sonnet" : "gpt-5.3-codex"));
	const tsRaw = o.timestamp ?? o.ts ?? o.created_at ?? Date.now();
	const ts = typeof tsRaw === "number" ? tsRaw : Date.parse(String(tsRaw));
	if (!Number.isFinite(ts)) return null;
	const tokensIn = num(usage.input_tokens ?? usage.prompt_tokens ?? usage.tokensIn ?? o.tokensIn);
	const tokensOut = num(usage.output_tokens ?? usage.completion_tokens ?? usage.tokensOut ?? o.tokensOut);
	const cacheRead = num(usage.cache_read_input_tokens ?? usage.cache_read ?? o.cacheRead);
	const cacheWrite = num(usage.cache_creation_input_tokens ?? usage.cache_write ?? o.cacheWrite);
	const reasoningMin = num(usage.reasoning_minutes ?? o.reasoningMin ?? o.reasoning_minutes);
	if (tokensIn + tokensOut + cacheRead + cacheWrite + reasoningMin <= 0) return null;
	return {
		id: String(o.id ?? `imp_${ts}_${index}`),
		agent,
		model: asModel(modelRaw, agent),
		ts,
		sessionId: String(o.session_id ?? o.sessionId ?? o.conversation_id ?? `imp_sess_${index}`),
		task: String(o.task ?? o.cwd ?? o.prompt ?? "导入会话"),
		tokensIn,
		tokensOut,
		cacheRead,
		cacheWrite,
		reasoningMin
	};
}
function parseUsagePayload(text, fallbackAgent = "claude") {
	const trimmed = text.trim();
	if (!trimmed) return [];
	const events = [];
	const tryJson = (blob) => {
		try {
			const data = JSON.parse(blob);
			if (Array.isArray(data)) {
				data.forEach((row, i) => {
					const ev = parseOne(row, fallbackAgent, i);
					if (ev) events.push(ev);
				});
				return true;
			}
			if (data && typeof data === "object") {
				const obj = data;
				const list = obj.events ?? obj.usage ?? obj.data;
				if (Array.isArray(list)) {
					list.forEach((row, i) => {
						const ev = parseOne(row, fallbackAgent, i);
						if (ev) events.push(ev);
					});
					return true;
				}
				const ev = parseOne(data, fallbackAgent, 0);
				if (ev) {
					events.push(ev);
					return true;
				}
			}
		} catch {
			return false;
		}
		return false;
	};
	if (tryJson(trimmed)) return events;
	trimmed.split(/\n+/).forEach((line, i) => {
		const t = line.trim();
		if (!t) return;
		try {
			const ev = parseOne(JSON.parse(t), fallbackAgent, i);
			if (ev) events.push(ev);
		} catch {}
	});
	return events.sort((a, b) => a.ts - b.ts);
}
function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a += 1831565813;
		let t = a;
		t = Math.imul(t ^ t >>> 15, t | 1);
		t ^= t + Math.imul(t ^ t >>> 7, t | 61);
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
}
var CLAUDE_TASKS = [
	"重构鉴权中间件",
	"补齐 dashboard 类型",
	"拆分 route 组件",
	"修 hydration 不一致",
	"写 PGLite 迁移",
	"扫描依赖漏洞",
	"整理 server function",
	"压测用量计算",
	"接入 ingest 协议",
	"校准 5 小时窗口"
];
var CODEX_TASKS = [
	"生成 API client",
	"补测试夹具",
	"迁移 Zod schema",
	"优化打包配置",
	"整理 eslint 规则",
	"写 ingest 适配器",
	"核对 token 权重",
	"补齐错误边界",
	"导出周报 JSON",
	"同步套餐预设"
];
function pick(rng, list) {
	return list[Math.floor(rng() * list.length)];
}
function id(rng, prefix) {
	return `${prefix}_${Math.floor(rng() * 1e9).toString(36)}${Math.floor(rng() * 1e9).toString(36)}`;
}
function claudeModel(rng) {
	const r = rng();
	if (r < .14) return "opus";
	if (r < .84) return "sonnet";
	return "haiku";
}
function codexModel(rng) {
	const r = rng();
	if (r < .2) return "gpt-5.4";
	if (r < .8) return "gpt-5.3-codex";
	return "gpt-5-codex-mini";
}
function makeEvent(rng, agent, ts, sessionId, task, model, intensity = 1) {
	if (agent === "claude") {
		const heavy = model === "opus";
		const tokensIn = Math.round((heavy ? 24e3 : 11e3) * (.7 + rng()) * intensity);
		const tokensOut = Math.round((heavy ? 2800 : 1400) * (.6 + rng()) * intensity);
		const cacheRead = Math.round((heavy ? 36e3 : 14e3) * (.4 + rng()));
		const cacheWrite = Math.round((heavy ? 5e3 : 1800) * (.4 + rng()) * intensity);
		return {
			id: id(rng, "ev"),
			agent,
			model,
			ts,
			sessionId,
			task,
			tokensIn,
			tokensOut,
			cacheRead,
			cacheWrite,
			reasoningMin: 0
		};
	}
	const reasoningMin = (model === "gpt-5.4" ? 3.1 : model === "gpt-5.3-codex" ? 1.8 : .7) * (.7 + rng()) * intensity;
	return {
		id: id(rng, "ev"),
		agent,
		model,
		ts,
		sessionId,
		task,
		tokensIn: Math.round(6200 * (.6 + rng()) * intensity),
		tokensOut: Math.round(2100 * (.5 + rng()) * intensity),
		cacheRead: Math.round(900 * rng()),
		cacheWrite: Math.round(500 * rng()),
		reasoningMin
	};
}
function fillAgent(rng, agent, now, windowTarget, weekTarget, boostPct) {
	const plan = planById(agent === "claude" ? "claude-max-5x" : "chatgpt-plus");
	const tasks = agent === "claude" ? CLAUDE_TASKS : CODEX_TASKS;
	const events = [];
	let guard = 0;
	const windowPct = () => inWindow(events, now, WINDOW_MS, agent).reduce((s, e) => s + eventWindowShare(e, plan), 0);
	const weekPct = () => inWindow(events, now, WEEK_MS, agent).reduce((s, e) => s + eventWeekShare(e, plan, boostPct), 0);
	const pushSession = (maxAgeH, minAgeH, intensity) => {
		const started = now - (minAgeH + rng() * Math.max(.05, maxAgeH - minAgeH)) * 36e5;
		const sessionId = id(rng, agent === "claude" ? "cc" : "cx");
		const task = pick(rng, tasks);
		const model = agent === "claude" ? claudeModel(rng) : codexModel(rng);
		const n = 3 + Math.floor(rng() * 5);
		for (let i = 0; i < n; i++) {
			const ts = Math.min(now - 3e4, started + i * (3 + rng() * 8) * 6e4);
			events.push(makeEvent(rng, agent, ts, sessionId, task, model, intensity));
		}
	};
	while (weekPct() < weekTarget && guard < 80) {
		pushSession(96, 8, .85);
		guard += 1;
	}
	guard = 0;
	while (windowPct() < windowTarget && guard < 40) {
		pushSession(4.6, .08, 1.15);
		guard += 1;
	}
	return events;
}
function seedHistory(now = Date.now()) {
	const day = new Date(now);
	const rng = mulberry32(day.getFullYear() * 1e4 + (day.getMonth() + 1) * 100 + day.getDate() + 41);
	return [...fillAgent(rng, "claude", now, 61, 34, 50), ...fillAgent(rng, "codex", now, 47, 28, 50)].sort((a, b) => a.ts - b.ts);
}
function nextLiveEvent(rng, agent, session, now) {
	return makeEvent(rng, agent, now, session.id, session.task, session.model, .72);
}
function newSession(rng, agent, now) {
	const tasks = agent === "claude" ? CLAUDE_TASKS : CODEX_TASKS;
	const model = agent === "claude" ? claudeModel(rng) : codexModel(rng);
	return {
		id: id(rng, agent === "claude" ? "cc" : "cx"),
		task: pick(rng, tasks),
		model,
		startedAt: now,
		events: 0,
		tokens: 0
	};
}
function liveRng() {
	return mulberry32((Date.now() ^ 2654435769) >>> 0);
}
var MAX_EVENTS = 720;
function trimEvents(events) {
	if (events.length <= MAX_EVENTS) return events;
	return events.slice(events.length - MAX_EVENTS);
}
function startPair(now) {
	const rng = liveRng();
	return {
		claudeSession: newSession(rng, "claude", now),
		codexSession: newSession(rng, "codex", now)
	};
}
function bumpSession(session, ev) {
	return {
		...session,
		events: session.events + 1,
		tokens: session.tokens + rawTokens(ev)
	};
}
var useQuota = create()(persist((set, get) => ({
	claudePlanId: "claude-max-5x",
	codexPlanId: "chatgpt-plus",
	weekBoostPct: 50,
	events: [],
	liveClaude: true,
	liveCodex: true,
	claudeSession: null,
	codexSession: null,
	lastBeat: 0,
	adapterHint: true,
	setPlan: (agent, id) => set(agent === "claude" ? { claudePlanId: id } : { codexPlanId: id }),
	setBoost: (n) => set({ weekBoostPct: Math.max(0, Math.min(100, Math.round(n))) }),
	toggleLive: (agent) => {
		const now = Date.now();
		const rng = liveRng();
		if (agent === "claude") {
			const on = !get().liveClaude;
			set({
				liveClaude: on,
				claudeSession: on ? get().claudeSession ?? newSession(rng, "claude", now) : get().claudeSession
			});
		} else {
			const on = !get().liveCodex;
			set({
				liveCodex: on,
				codexSession: on ? get().codexSession ?? newSession(rng, "codex", now) : get().codexSession
			});
		}
	},
	setBothLive: (on) => {
		const now = Date.now();
		const rng = liveRng();
		set({
			liveClaude: on,
			liveCodex: on,
			claudeSession: on ? get().claudeSession ?? newSession(rng, "claude", now) : get().claudeSession,
			codexSession: on ? get().codexSession ?? newSession(rng, "codex", now) : get().codexSession
		});
	},
	tick: (now = Date.now()) => {
		const state = get();
		const rng = liveRng();
		const emitted = [];
		let claudeSession = state.claudeSession ?? (state.liveClaude ? newSession(rng, "claude", now) : null);
		let codexSession = state.codexSession ?? (state.liveCodex ? newSession(rng, "codex", now) : null);
		const maybeRotate = (session, agent) => {
			if (session.events > 0 && (session.events >= 8 || now - session.startedAt > 108e4) && rng() < .22) return newSession(rng, agent, now);
			return session;
		};
		if (state.liveClaude && claudeSession && rng() < .62) {
			claudeSession = maybeRotate(claudeSession, "claude");
			const ev = nextLiveEvent(rng, "claude", claudeSession, now);
			emitted.push(ev);
			claudeSession = bumpSession(claudeSession, ev);
		}
		if (state.liveCodex && codexSession && rng() < .58) {
			codexSession = maybeRotate(codexSession, "codex");
			const ev = nextLiveEvent(rng, "codex", codexSession, now);
			emitted.push(ev);
			codexSession = bumpSession(codexSession, ev);
		}
		if (!emitted.length) {
			set({
				lastBeat: now,
				claudeSession,
				codexSession
			});
			return emitted;
		}
		set({
			events: trimEvents([...state.events, ...emitted]),
			lastBeat: now,
			claudeSession,
			codexSession
		});
		return emitted;
	},
	importText: (text, agent) => {
		const parsed = parseUsagePayload(text, agent);
		if (!parsed.length) return 0;
		set({ events: trimEvents([...get().events, ...parsed].sort((a, b) => a.ts - b.ts)) });
		return parsed.length;
	},
	resetDemo: () => {
		const now = Date.now();
		set({
			events: seedHistory(now),
			...startPair(now),
			lastBeat: now,
			liveClaude: true,
			liveCodex: true
		});
	},
	setHint: (on) => set({ adapterHint: on })
}), {
	name: "synq-quota-v3",
	partialize: (s) => ({
		claudePlanId: s.claudePlanId,
		codexPlanId: s.codexPlanId,
		weekBoostPct: s.weekBoostPct,
		events: s.events.slice(-720),
		liveClaude: s.liveClaude,
		liveCodex: s.liveCodex,
		adapterHint: s.adapterHint
	})
}));
var SAMPLE = `{
  "agent": "claude",
  "model": "sonnet",
  "timestamp": ${Date.now() - 12e4},
  "session_id": "cc_demo",
  "task": "导入的一次会话",
  "usage": {
    "input_tokens": 8200,
    "output_tokens": 1100,
    "cache_read_input_tokens": 24000,
    "cache_creation_input_tokens": 1800
  }
}`;
function PluginPanel() {
	const importText = useQuota((s) => s.importText);
	const [blob, setBlob] = (0, import_react.useState)(SAMPLE);
	const [agent, setAgent] = (0, import_react.useState)("claude");
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "grid gap-5 lg:grid-cols-2",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Card, { children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(CardTitle, { children: "适配器" }),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(CardHint, {
					className: "mt-1",
					children: "Sidecar 并排监听两款 Agent 的会话落盘，统一折成额度。"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("ul", {
					className: "mt-4 space-y-3 text-sm",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
						className: "rounded-lg bg-raised px-3 py-3",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "font-medium text-claude",
								children: "Claude Code"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "mt-1 font-mono text-xs text-mute",
								children: "~/.claude/projects/**/*.jsonl"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "mt-1 text-xs text-mute",
								children: "读取 message.usage，含 cache read / write。"
							})
						]
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
						className: "rounded-lg bg-raised px-3 py-3",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "font-medium text-codex",
								children: "Codex CLI"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "mt-1 font-mono text-xs text-mute",
								children: "~/.codex/sessions · /status · /usage"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "mt-1 text-xs text-mute",
								children: "同时计量 token 与推理分钟，对齐 5 小时窗。"
							})
						]
					})]
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "mt-4 text-xs leading-relaxed text-mute",
					children: "预览里用实时模拟代替本机文件监听。把 JSON / JSONL 粘贴到右侧即可并入计算。"
				})
			] }),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Card, { children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(CardTitle, { children: "导入用量" }),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(CardHint, {
					className: "mt-1",
					children: "支持单条 JSON、数组，或 Claude Code 风格 JSONL。"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "mt-4 flex gap-2",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
						size: "sm",
						variant: agent === "claude" ? "claude" : "secondary",
						onClick: () => setAgent("claude"),
						children: "默认 Claude"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
						size: "sm",
						variant: agent === "codex" ? "codex" : "secondary",
						onClick: () => setAgent("codex"),
						children: "默认 Codex"
					})]
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Textarea, {
					className: "mt-3",
					value: blob,
					onChange: (e) => setBlob(e.target.value),
					spellCheck: false,
					"aria-label": "用量 JSON"
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
					className: "mt-3",
					onClick: () => {
						const n = importText(blob, agent);
						if (n) toast.success(`已并入 ${n} 条事件`);
						else toast.error("没有解析到有效用量");
					},
					children: "并入额度"
				})
			] }),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Card, {
				className: "lg:col-span-2",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(CardTitle, { children: "事件协议" }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(CardHint, {
						className: "mt-1",
						children: "本地 sidecar 或 CI 钩子按此形状推送即可。"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", {
						className: "mt-4 overflow-x-auto rounded-lg bg-raised p-4 font-mono text-xs leading-relaxed text-mute",
						children: `type UsageEvent = {
  agent: "claude" | "codex"
  model: string
  timestamp: number | ISO8601
  session_id: string
  task?: string
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    reasoning_minutes?: number   // Codex
  }
}`
					})
				]
			})
		]
	});
}
function sessionsInWindow(events, agent, now) {
	const from = now - WINDOW_MS;
	const slice = events.filter((e) => e.agent === agent && e.ts >= from && e.ts <= now);
	const map = /* @__PURE__ */ new Map();
	for (const e of slice) {
		const cur = map.get(e.sessionId);
		if (!cur) map.set(e.sessionId, {
			start: e.ts,
			end: e.ts,
			tokens: rawTokens(e),
			task: e.task
		});
		else {
			cur.start = Math.min(cur.start, e.ts);
			cur.end = Math.max(cur.end, e.ts);
			cur.tokens += rawTokens(e);
		}
	}
	return [...map.values()].map((s) => ({
		...s,
		end: Math.max(s.end, s.start + 24e4)
	}));
}
function Lane({ agent, events, now }) {
	const blocks = sessionsInWindow(events, agent, now);
	const from = now - WINDOW_MS;
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "relative h-9 overflow-hidden rounded-md bg-raised",
		children: [blocks.map((b, i) => {
			const left = (b.start - from) / WINDOW_MS * 100;
			const width = Math.max(1.6, (b.end - b.start) / WINDOW_MS * 100);
			return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				title: b.task,
				className: cn("absolute top-1.5 bottom-1.5 rounded-sm", agent === "claude" ? "bg-claude/80" : "bg-codex/80"),
				style: {
					left: `${left}%`,
					width: `${width}%`
				}
			}, `${agent}-${i}-${b.start}`);
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "absolute inset-y-0 right-0 w-px bg-ink/50" })]
	});
}
function DualTimeline({ events, now }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-3",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between text-xs text-mute",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "5 小时滚动窗" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
					className: "font-mono tabular",
					children: "现在"
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "space-y-2",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "grid grid-cols-[4.5rem_1fr] items-center gap-3",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "text-xs font-medium text-claude",
						children: "Claude"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Lane, {
						agent: "claude",
						events,
						now
					})]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "grid grid-cols-[4.5rem_1fr] items-center gap-3",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "text-xs font-medium text-codex",
						children: "Codex"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Lane, {
						agent: "codex",
						events,
						now
					})]
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "grid grid-cols-[4.5rem_1fr] gap-3",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "flex justify-between font-mono text-[10px] tracking-wide text-faint",
					children: [
						5,
						4,
						3,
						2,
						1,
						0
					].map((h) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: h === 0 ? "now" : `-${h}h` }, h))
				})]
			})
		]
	});
}
function UsageChart({ events, now }) {
	const data = hourlySeries(events, now, 24);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "h-48 w-full",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ResponsiveContainer, {
			width: "100%",
			height: "100%",
			children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(AreaChart, {
				data,
				margin: {
					top: 8,
					right: 4,
					left: 0,
					bottom: 0
				},
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("defs", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("linearGradient", {
						id: "gClaude",
						x1: "0",
						y1: "0",
						x2: "0",
						y2: "1",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("stop", {
							offset: "0%",
							stopColor: "var(--color-claude)",
							stopOpacity: .45
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("stop", {
							offset: "100%",
							stopColor: "var(--color-claude)",
							stopOpacity: 0
						})]
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("linearGradient", {
						id: "gCodex",
						x1: "0",
						y1: "0",
						x2: "0",
						y2: "1",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("stop", {
							offset: "0%",
							stopColor: "var(--color-codex)",
							stopOpacity: .4
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("stop", {
							offset: "100%",
							stopColor: "var(--color-codex)",
							stopOpacity: 0
						})]
					})] }),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(XAxis, {
						dataKey: "label",
						tick: {
							fill: "var(--color-faint)",
							fontSize: 10,
							fontFamily: "IBM Plex Mono"
						},
						tickLine: false,
						axisLine: false,
						interval: 3
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(YAxis, {
						tickFormatter: (v) => formatTokens(Number(v)),
						tick: {
							fill: "var(--color-faint)",
							fontSize: 10,
							fontFamily: "IBM Plex Mono"
						},
						tickLine: false,
						axisLine: false,
						width: 36
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Tooltip, {
						contentStyle: {
							background: "var(--color-surface)",
							border: "1px solid var(--color-line)",
							borderRadius: 12,
							fontSize: 12
						},
						labelStyle: { color: "var(--color-mute)" },
						formatter: (value, name) => [formatTokens(Number(value ?? 0)), name === "claude" ? "Claude" : "Codex"]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Area, {
						type: "monotone",
						dataKey: "claude",
						stroke: "var(--color-claude)",
						fill: "url(#gClaude)",
						strokeWidth: 1.5
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Area, {
						type: "monotone",
						dataKey: "codex",
						stroke: "var(--color-codex)",
						fill: "url(#gCodex)",
						strokeWidth: 1.5
					})
				]
			})
		})
	});
}
var createSsrRpc = (functionId) => {
	const url = "/_serverFn/" + functionId;
	const serverFnMeta = { id: functionId };
	const fn = async (...args) => {
		return (await getServerFnById(functionId, { origin: "server" }))(...args);
	};
	return Object.assign(fn, {
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
var loadSettings = createServerFn({ method: "GET" }).middleware([authMiddleware]).handler(createSsrRpc("c014ba2c2d4b43d226a4131745e146d1bbf0a623f4cb52fb11f6bf0ba1f3e518"));
var saveSettings = createServerFn({ method: "POST" }).middleware([authMiddleware]).validator((data) => settingsSchema.parse(data)).handler(createSsrRpc("d811944b1a16441d70a516832a15ee7b8d1c2547790c84997eb34fbe38c3f484"));
function seedIfEmpty() {
	if (useQuota.getState().events.length === 0) useQuota.getState().resetDemo();
}
function Dashboard() {
	const [view, setView] = (0, import_react.useState)("monitor");
	const [now, setNow] = (0, import_react.useState)(() => Date.now());
	const { user, isPending } = useCurrentUserState();
	const warned = (0, import_react.useRef)({
		claude: false,
		codex: false
	});
	const events = useQuota((s) => s.events);
	const liveClaude = useQuota((s) => s.liveClaude);
	const liveCodex = useQuota((s) => s.liveCodex);
	const claudePlanId = useQuota((s) => s.claudePlanId);
	const codexPlanId = useQuota((s) => s.codexPlanId);
	const weekBoostPct = useQuota((s) => s.weekBoostPct);
	const claudeSession = useQuota((s) => s.claudeSession);
	const codexSession = useQuota((s) => s.codexSession);
	const adapterHint = useQuota((s) => s.adapterHint);
	(0, import_react.useEffect)(() => {
		const persist = useQuota.persist;
		const unsub = persist.onFinishHydration(seedIfEmpty);
		if (persist.hasHydrated()) seedIfEmpty();
		return unsub;
	}, []);
	(0, import_react.useEffect)(() => {
		if (isPending || !user) return;
		let cancelled = false;
		loadSettings().then((saved) => {
			if (cancelled || !saved) return;
			useQuota.setState({
				claudePlanId: saved.claudePlanId,
				codexPlanId: saved.codexPlanId,
				weekBoostPct: saved.weekBoostPct
			});
		}).catch(() => void 0);
		return () => {
			cancelled = true;
		};
	}, [user, isPending]);
	(0, import_react.useEffect)(() => {
		if (isPending || !user) return;
		const handle = window.setTimeout(() => {
			saveSettings({ data: {
				claudePlanId,
				codexPlanId,
				weekBoostPct
			} }).catch(() => void 0);
		}, 600);
		return () => window.clearTimeout(handle);
	}, [
		user,
		isPending,
		claudePlanId,
		codexPlanId,
		weekBoostPct
	]);
	(0, import_react.useEffect)(() => {
		const id = window.setInterval(() => {
			const emitted = useQuota.getState().tick();
			const t = Date.now();
			setNow(t);
			if (!emitted.length) return;
			const state = useQuota.getState();
			const claude = planById(state.claudePlanId);
			const codex = planById(state.codexPlanId);
			if (emitted.some((e) => e.agent === "claude")) {
				const m = meterFor(state.events, "claude", claude, t, state.weekBoostPct);
				if (m.windowPct >= 92 && !warned.current.claude) {
					warned.current.claude = true;
					toast.error("Claude Code 五小时窗即将耗尽");
				}
				if (m.windowPct < 80) warned.current.claude = false;
			}
			if (emitted.some((e) => e.agent === "codex")) {
				const m = meterFor(state.events, "codex", codex, t, state.weekBoostPct);
				if (m.windowPct >= 92 && !warned.current.codex) {
					warned.current.codex = true;
					toast.error("Codex 五小时窗即将耗尽");
				}
				if (m.windowPct < 80) warned.current.codex = false;
			}
		}, 2600);
		return () => window.clearInterval(id);
	}, []);
	const claudePlan = planById(claudePlanId);
	const codexPlan = planById(codexPlanId);
	const claudeMeter = (0, import_react.useMemo)(() => meterFor(events, "claude", claudePlan, now, weekBoostPct), [
		events,
		claudePlan,
		now,
		weekBoostPct
	]);
	const codexMeter = (0, import_react.useMemo)(() => meterFor(events, "codex", codexPlan, now, weekBoostPct), [
		events,
		codexPlan,
		now,
		weekBoostPct
	]);
	const live = liveClaude || liveCodex;
	const combinedUsd = claudeMeter.apiUsdWeek + codexMeter.apiUsdWeek;
	const subUsd = (claudePlan.kind === "subscription" ? claudePlan.priceUsd : 0) + (codexPlan.kind === "subscription" ? codexPlan.priceUsd : 0);
	const tighter = claudeMeter.windowPct >= codexMeter.windowPct ? claudeMeter : codexMeter;
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "min-h-dvh bg-canvas text-ink",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Toaster, {
				theme: "dark",
				position: "bottom-center",
				toastOptions: { className: "!bg-surface !text-ink !border-line" }
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Header, {
				view,
				onView: setView,
				live
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("main", {
				className: "mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8",
				children: [
					adapterHint && view === "monitor" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "mb-5 flex flex-col gap-3 rounded-xl bg-surface px-4 py-3 shadow-[var(--shadow-border)] sm:flex-row sm:items-center",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "flex-1 text-sm text-mute",
							children: "预览正在模拟 sidecar：Claude Code 与 Codex 同时跑任务，用量会打进同一个 5 小时窗。"
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
							size: "sm",
							variant: "ghost",
							onClick: () => useQuota.getState().setHint(false),
							children: "知道了"
						})]
					}) : null,
					view === "monitor" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "space-y-5",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
								className: "grid gap-5 lg:grid-cols-[minmax(0,17rem)_1fr]",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Card, { children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
										className: "text-xs text-mute",
										children: "更紧的窗口"
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
										className: "mt-2 font-mono text-5xl leading-none font-medium tracking-tight tabular",
										children: [Math.max(0, 100 - tighter.windowPct).toFixed(0), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
											className: "ml-1 text-xl text-mute",
											children: "%"
										})]
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", {
										className: "mt-3 text-sm text-mute",
										children: [tighter.agent === "claude" ? "Claude Code" : "Codex", " 先碰到上限"]
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("dl", {
										className: "mt-5 space-y-2 text-xs",
										children: [
											/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
												className: "flex justify-between",
												children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
													className: "text-faint",
													children: "本周等价 API"
												}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", {
													className: "font-mono tabular",
													children: formatUsd(combinedUsd)
												})]
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
												className: "flex justify-between",
												children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
													className: "text-faint",
													children: "订阅合计"
												}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", {
													className: "font-mono tabular",
													children: subUsd ? `$${subUsd}/月` : "按量"
												})]
											}),
											/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
												className: "flex justify-between",
												children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
													className: "text-faint",
													children: "窗口回补"
												}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", {
													className: "font-mono tabular",
													children: formatDuration(Math.max(0, tighter.windowResetsAt - now))
												})]
											})
										]
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Button, {
										variant: "secondary",
										size: "sm",
										className: "mt-5 w-full",
										onClick: () => {
											useQuota.getState().resetDemo();
											setNow(Date.now());
											toast.message("已重置为今日演示数据");
										},
										children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(RotateCcw, {}), "重置演示"]
									})
								] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Card, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
									className: "mb-4 flex flex-wrap items-center justify-between gap-3",
									children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(CardTitle, { children: "协同时间线" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(CardHint, {
										className: "mt-1",
										children: "两台 Agent 共享同一口 5 小时时钟"
									})] }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
										size: "sm",
										variant: live ? "secondary" : "default",
										onClick: () => useQuota.getState().setBothLive(!live),
										children: live ? "全部暂停" : "开始协同"
									})]
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DualTimeline, {
									events,
									now
								})] })]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
								className: "grid gap-5 lg:grid-cols-2",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(AgentCard, {
									name: "Claude Code",
									adapter: "~/.claude",
									plan: claudePlan,
									meter: claudeMeter,
									session: claudeSession,
									live: liveClaude,
									events,
									now,
									onToggle: () => useQuota.getState().toggleLive("claude")
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(AgentCard, {
									name: "Codex",
									adapter: "~/.codex",
									plan: codexPlan,
									meter: codexMeter,
									session: codexSession,
									live: liveCodex,
									events,
									now,
									onToggle: () => useQuota.getState().toggleLive("codex")
								})]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
								className: "grid gap-5 lg:grid-cols-[1.2fr_0.8fr]",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Card, { children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(CardTitle, { children: "近 24 小时 token" }),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(CardHint, {
										className: "mt-1",
										children: "按小时叠加，便于看双开时的燃烧节奏"
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										className: "mt-3",
										children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(UsageChart, {
											events,
											now
										})
									})
								] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Card, { children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(CardTitle, { children: "实时流水" }),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(CardHint, {
										className: "mt-1",
										children: "适配器刚刚打进来的回合"
									}),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
										className: "mt-3",
										children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(EventFeed, {
											events,
											now
										})
									})
								] })]
							})
						]
					}) : null,
					view === "plans" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(PlansPanel, {
						claudePlanId,
						codexPlanId,
						weekBoostPct,
						onClaude: (id) => useQuota.getState().setPlan("claude", id),
						onCodex: (id) => useQuota.getState().setPlan("codex", id),
						onBoost: (n) => useQuota.getState().setBoost(n)
					}) : null,
					view === "plugin" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(PluginPanel, {}) : null
				]
			})
		]
	});
}
function Home() {
	const [ready, setReady] = (0, import_react.useState)(false);
	(0, import_react.useEffect)(() => setReady(true), []);
	if (!ready) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: "min-h-dvh bg-canvas px-4 py-8 text-ink",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "mx-auto max-w-6xl space-y-4",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "h-16 rounded-xl bg-surface" }),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "grid gap-4 lg:grid-cols-[17rem_1fr]",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "h-64 rounded-2xl bg-surface" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "h-64 rounded-2xl bg-surface" })]
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "grid gap-4 lg:grid-cols-2",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "h-80 rounded-2xl bg-surface" }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "h-80 rounded-2xl bg-surface" })]
				})
			]
		})
	});
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Dashboard, {});
}
//#endregion
export { Home as component };
