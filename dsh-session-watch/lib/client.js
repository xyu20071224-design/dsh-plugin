/**
 * session-watch — Client half.
 *
 * One root-scope occupant: `sidebar.footer.action` renders a stall indicator
 * beside Settings. It shows how many sessions have silently stopped, and lists
 * them on demand so the user can see WHICH conversation needs attention without
 * opening every tab.
 *
 * The button owns no detection logic. It reads the Host's `/session-watch/api/state`
 * and renders what the Host decided, so the judgement lives in exactly one place
 * (the deterministic detector in `lib/detect.js`) and the UI cannot drift from it.
 *
 * Written by hand as a `window.__ModuleLoader__` bundle: the loader hands the
 * factory a `require` for platform modules only (`react` here), so everything else
 * must be inline. There is no build step for this file.
 *
 * @module dsh-session-watch/client
 */

window.__ModuleLoader__.load({
	id: "dsh-session-watch",
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
		let react = require("react")

		const API = "/session-watch/api"
		const HEADERS = { "x-session-watch": "1" }
		/**
		 * The Host re-scans on its own schedule, so this only needs to be short
		 * enough that a newly detected stall shows up while the user is looking.
		 */
		const POLL_MS = 20000

		/* ── i18n: Chinese strings are the keys, EN is the translation table ── */
		const EN = {
			"会话监视": "Session watch",
			"个会话静默停摆": "session(s) silently stalled",
			"没有静默停摆的会话": "No silently stalled sessions",
			"正在检查…": "Checking…",
			"请求失败": "Request failed",
			"点击查看需要关注的会话": "Click to list the sessions needing attention",
			"会话": "Session",
			"目录": "Directory",
			"最后事件": "Last event",
			"静默": "Silent for",
			"位置": "Position",
			"刷新": "Refresh",
			"判定口径": "Rule",
			"个会话": "session(s)",
			"等待审批": "awaiting approval",
			"空会话": "empty",
			"自动恢复": "Auto-resume",
			"已启用": "enabled",
			"未启用": "disabled",
			"仅报告": "report only",
			"本轮恢复": "Resumed this scan",
			"次": "time(s)",
			"已自动恢复": "Auto-resumed",
			"将恢复": "will resume",
			"不恢复": "will not resume",
			"上限": "cap",
			"上一次由": "Last attempt by",
			"自动": "the watcher",
			"专家": "the expert",
			"成功": "succeeded",
			"失败": "failed",
			"用户代理专家": "User-proxy expert",
			"已挂载": "mounted",
			"未挂载": "not mounted",
			"需重启 dsh 才会加载": "restart dsh to load it",
			"下一步": "Next step",
			"你本人": "you",
		}
		let activeLocale = "zh"
		function tr(text) {
			return activeLocale === "en" ? (EN[text] ?? text) : text
		}

		/* ── module-level store: one snapshot shared by every render ── */
		const listeners = new Set()
		let snapshot = {
			/** null until the first answer arrives, so the button renders neutral. */
			stalled: null,
			attention: [],
			totals: null,
			stallMs: null,
			/** Whether the Host is allowed to auto-resume; null until known. */
			resumeEnabled: null,
			resumePolicy: null,
			/** Resume attempts performed by the most recent scan. */
			resumed: [],
			/**
			 * Whether the user-proxy expert's tools are live. null until known.
			 *
			 * Kept separate from `resumeEnabled` because they are different facts:
			 * auto-resume is a policy the Host can enforce alone, while the expert is a
			 * composed preset that may fail to mount. "Installed" and "mounted" are not
			 * the same, and only the second means layer 3 can be used.
			 */
			expert: null,
			open: false,
			busy: false,
			error: null,
		}
		function getSnapshot() {
			return snapshot
		}
		function subscribe(listener) {
			listeners.add(listener)
			return () => { listeners.delete(listener) }
		}
		function patch(next) {
			snapshot = { ...snapshot, ...next }
			for (const listener of [...listeners]) listener()
		}

		/**
		 * Read the Host's snapshot. A failed read keeps the last known counts and
		 * surfaces the reason, rather than blanking the badge to "all clear" —
		 * a watcher that silently reports zero stalls when it is broken would be
		 * worse than no watcher at all.
		 * @returns {Promise<void>} resolves after the store settles.
		 */
		async function refresh() {
			try {
				const response = await fetch(`${API}/state`, { headers: HEADERS })
				if (!response.ok) throw new Error(`HTTP ${response.status}`)
				const body = await response.json()
				adopt(body)
			} catch (error) {
				patch({ error: String(error?.message ?? error) })
			}
		}

		/**
		 * Adopt a Host snapshot into the store.
		 *
		 * Shared by the read and force-refresh paths so the two can never disagree
		 * about which fields they understand.
		 * @param {any} body - the Host's snapshot payload.
		 * @returns {void}
		 */
		function adopt(body) {
			const attention = Array.isArray(body?.attention) ? body.attention : []
			patch({
				stalled: attention.length,
				attention,
				totals: body?.totals ?? null,
				stallMs: typeof body?.stallMs === "number" ? body.stallMs : null,
				resumeEnabled: typeof body?.resumeEnabled === "boolean" ? body.resumeEnabled : null,
				resumePolicy: body?.resumePolicy ?? null,
				resumed: Array.isArray(body?.resumed) ? body.resumed : [],
				// Passed through whole rather than field-by-field: the panel renders
				// `mounted` and `tools`, and a whitelist here would silently drop a
				// future field — which is exactly how `expert` was lost the first time.
				// Normalized only enough to guarantee the shape the render reads.
				expert: body?.expert === undefined || body?.expert === null
					? null
					: {
						mounted: body.expert.mounted === true,
						tools: Array.isArray(body.expert.tools) ? body.expert.tools : [],
						mountedAt: typeof body.expert.mountedAt === "number" ? body.expert.mountedAt : null,
						staleFromPid: typeof body.expert.staleFromPid === "number" ? body.expert.staleFromPid : null,
					},
				error: body?.ok === false ? String(body?.error ?? "Host 扫描失败") : null,
			})
		}

		/** Force the Host to re-scan, then adopt its answer. */
		async function forceRefresh() {
			if (snapshot.busy) return
			patch({ busy: true })
			try {
				const response = await fetch(`${API}/refresh`, { method: "POST", headers: HEADERS })
				if (!response.ok) throw new Error(`HTTP ${response.status}`)
				adopt(await response.json())
			} catch (error) {
				patch({ error: String(error?.message ?? error) })
			} finally {
				patch({ busy: false })
			}
		}

		/* ── formatting helpers ── */
		/**
		 * Render a duration in the largest sensible unit.
		 * @param {number} ms - duration in milliseconds.
		 * @returns {string} a short human label.
		 */
		function humanDuration(ms) {
			if (!Number.isFinite(ms) || ms <= 0) return "0s"
			const seconds = Math.round(ms / 1000)
			if (seconds < 60) return `${seconds}s`
			const minutes = Math.round(seconds / 60)
			if (minutes < 60) return `${minutes}m`
			const hours = Math.floor(minutes / 60)
			return `${hours}h${minutes % 60}m`
		}

		/**
		 * Shorten a working directory to its last segment for display.
		 * @param {string|null} cwd - absolute path, if known.
		 * @returns {string} a display label.
		 */
		function shortCwd(cwd) {
			if (typeof cwd !== "string" || cwd === "") return "(未知目录)"
			const parts = cwd.split(/[\\/]/).filter(Boolean)
			return parts.length === 0 ? cwd : parts[parts.length - 1]
		}

		/* ── components ── */
		function useStore() {
			return react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
		}

		/**
		 * The panel listing stalled sessions. Rendered inline above the sidebar
		 * button when open, so the user never has to leave the page.
		 * @returns {any} the React element.
		 */
		function StallPanel() {
			const state = useStore()
			const items = state.attention
			return react.createElement(
				"div",
				{
					"data-session-watch": "panel",
					style: {
						margin: "0 8px 8px",
						padding: 10,
						border: "1px solid var(--dsw-alias-border-l1)",
						borderRadius: 10,
						background: "var(--dsw-alias-bg-layer-2)",
						fontSize: 12,
						maxHeight: 320,
						overflowY: "auto",
					},
				},
				react.createElement(
					"div",
					{ style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 } },
					react.createElement("strong", null, tr("会话监视")),
					react.createElement(
						"button",
						{
							type: "button",
							onClick: () => { void forceRefresh() },
							disabled: state.busy,
							style: {
								border: "1px solid var(--dsw-alias-border-l1)",
								background: "transparent",
								color: "var(--dsw-alias-label-secondary)",
								borderRadius: 6,
								padding: "2px 8px",
								fontSize: 11,
								cursor: state.busy ? "progress" : "pointer",
							},
						},
						tr("刷新"),
					),
				),
				state.stallMs !== null
					? react.createElement(
						"div",
						{ style: { color: "var(--dsw-alias-label-secondary)", marginBottom: 8 } },
						`${tr("判定口径")}：${tr("静默")} ≥ ${humanDuration(state.stallMs)}`,
					)
					: null,
				state.error !== null
					? react.createElement(
						"div",
						{ style: { color: "var(--dsw-alias-label-warning, #d4380d)", marginBottom: 8 } },
						`${tr("请求失败")}：${state.error}`,
					)
					: null,
				// The auto-resume state is shown unconditionally, including when it is
				// off. A user must never have to guess whether the harness is acting on
				// stalled sessions by itself, and a refusal reason is as informative as
				// an action.
				react.createElement(
					"div",
					{ style: { color: "var(--dsw-alias-label-secondary)", marginBottom: 8 } },
					`${tr("自动恢复")}：${state.resumeEnabled === true ? tr("已启用") : tr("未启用")}`
					+ (state.resumeEnabled === true && state.resumePolicy !== null
						? `（${tr("上限")} ${state.resumePolicy.maxAttempts} ${tr("次")}）`
						: `（${tr("仅报告")}）`),
				),
				state.resumed.length > 0
					? react.createElement(
						"div",
						{ style: { color: "var(--dsw-alias-label-secondary)", marginBottom: 8 } },
						`${tr("本轮恢复")}：` + state.resumed.map(entry => (entry.ok
							? `${String(entry.sessionId).slice(0, 12)}… ✓`
							: `${String(entry.sessionId).slice(0, 12)}… ✗ ${entry.code ?? ""}`)).join("，"),
					)
					: null,
				// Layer 3's only externally visible state. "Installed" and "mounted" are
				// different facts, and the sidebar is where the user would look.
				react.createElement(
					"div",
					{ style: { color: "var(--dsw-alias-label-secondary)", marginBottom: 8 } },
					`${tr("用户代理专家")}：${state.expert?.mounted === true
						? `${tr("已挂载")}（${(state.expert.tools ?? []).join("、")}）`
						: `${tr("未挂载")}（${tr("需重启 dsh 才会加载")}）`}`,
				),
				items.length === 0
					? react.createElement(
						"div",
						{ style: { color: "var(--dsw-alias-label-secondary)" } },
						tr("没有静默停摆的会话"),
					)
					: items.map(item => react.createElement(
						"div",
						{
							key: item.sessionId,
							style: {
								padding: "6px 0",
								borderTop: "1px solid var(--dsw-alias-border-l1)",
							},
						},
						react.createElement(
							"div",
							{ style: { fontWeight: 600, wordBreak: "break-all" } },
							`${tr("会话")} ${String(item.sessionId).slice(0, 18)}…`,
						),
						react.createElement(
							"div",
							{ style: { color: "var(--dsw-alias-label-secondary)" } },
							`${tr("目录")}：${shortCwd(item.cwd)}`,
						),
						react.createElement(
							"div",
							{ style: { color: "var(--dsw-alias-label-secondary)" } },
							`${tr("位置")}：turn=${item.turn ?? "?"} step=${item.step ?? "?"}`,
						),
						react.createElement(
							"div",
							{ style: { color: "var(--dsw-alias-label-secondary)" } },
							`${tr("最后事件")}：${item.lastType ?? "?"}，${tr("静默")} ${humanDuration(item.silentMs)}`,
						),
						item.resume !== undefined
							? react.createElement(
								"div",
								{ style: { color: "var(--dsw-alias-label-secondary)" } },
								`${tr("自动恢复")}：${item.resume.willResume === true ? tr("将恢复") : tr("不恢复")}`
								+ `——${item.resume.detail ?? ""}`
								+ (item.resume.attempts > 0 ? `（${tr("已自动恢复")} ${item.resume.attempts} ${tr("次")}）` : ""),
							)
							: null,
						// WHO nudged it last. "resumed twice" alone hides the difference
						// between the watcher acting on its own and the user-proxy expert
						// acting for the user — and an automatic action nobody can attribute
						// is indistinguishable from the harness acting alone.
						item.resume !== undefined && item.resume.lastAttemptBy !== null && item.resume.lastAttemptBy !== undefined
							? react.createElement(
								"div",
								{ style: { color: "var(--dsw-alias-label-secondary)" } },
								// Name the ACTUAL sender. A two-way "auto or expert" split showed a
								// manual nudge as the expert's work — the same misattribution the
								// nudge text itself was fixed for. The panel is where the user
								// checks who touched their session, so it must know all three.
								`${tr("上一次由")}：${item.resume.lastAttemptBy === "auto"
									? tr("自动")
									: item.resume.lastAttemptBy === "manual" ? tr("你本人") : tr("专家")}`
								+ `，${item.resume.lastAttemptOk === true ? tr("成功") : tr("失败")}`
								+ (typeof item.resume.lastAttemptCode === "string" ? `（${item.resume.lastAttemptCode}）` : ""),
							)
							: null,
						// The next step. Layers 1-2 are automatic and layer 3 is a judgement,
						// so when policy deliberately stops, the loop has arrived at the point
						// where a person takes over. Reporting only the reason would leave the
						// user holding a stopped session with nowhere to go — the original
						// problem this plugin exists to solve, one layer up.
						typeof item.handoff?.text === "string"
							? react.createElement(
								"div",
								{ style: { color: "var(--dsw-alias-label-warning, #d4380d)", marginTop: 2 } },
								`${tr("下一步")}：${item.handoff.text}`,
							)
							: null,
					)),
			)
		}

		/**
		 * The sidebar footer control: a badge that expands its own panel.
		 *
		 * The badge and the panel are ONE registration, not two. The slot API
		 * accepts only `{name, id, order, label, priority, children, store,
		 * locale, inject, registrant}` — there is no `visible` predicate — so a
		 * separate panel registration would always render and always occupy a
		 * sidebar row. Owning both in one component keeps the collapse explicit.
		 * @param {any} props - slot props; `wide` is false in the collapsed rail.
		 * @returns {any} the React element.
		 */
		function WatchButton(props) {
			const state = useStore()
			const wide = props && props.wide !== false
			const count = state.stalled
			// Only an actual stall is alarming. A null count means "not read yet",
			// which must not be dressed up as either success or failure.
			const alarming = typeof count === "number" && count > 0
			const title = state.error !== null
				? `${tr("会话监视")}：${tr("请求失败")} — ${state.error}`
				: alarming
					? `${count} ${tr("个会话静默停摆")} — ${tr("点击查看需要关注的会话")}`
					: tr("没有静默停摆的会话")
			const button = react.createElement(
				"button",
				{
					type: "button",
					title,
					"aria-label": title,
					"aria-expanded": state.open,
					"data-stalled": alarming ? String(count) : "0",
					onClick: () => { patch({ open: !state.open }); void refresh() },
					style: {
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						gap: 8,
						width: wide ? "auto" : 32,
						height: 32,
						padding: wide ? "0 10px" : 0,
						border: `1px solid ${alarming ? "var(--dsw-alias-label-warning, #d4380d)" : "var(--dsw-alias-border-l1)"}`,
						background: alarming ? "var(--dsw-alias-bg-layer-2)" : "transparent",
						color: alarming
							? "var(--dsw-alias-label-warning, #d4380d)"
							: "var(--dsw-alias-label-secondary)",
						borderRadius: 8,
						fontSize: 12,
						cursor: "pointer",
						opacity: state.stalled === null ? 0.6 : 1,
					},
				},
				react.createElement(
					"span",
					{ "aria-hidden": "true", style: { fontSize: 14, lineHeight: 1, filter: alarming ? "none" : "grayscale(1)" } },
					alarming ? "⏳" : "👁",
				),
				wide
					? react.createElement(
						"span",
						null,
						alarming ? `${count} ${tr("个会话静默停摆")}` : tr("会话监视"),
					)
					: alarming
						? react.createElement(
							"span",
							{ style: { fontSize: 11, fontWeight: 700 } },
							String(count),
						)
						: null,
			)
			return react.createElement(
				"div",
				{ "data-session-watch": "root", style: { width: "100%" } },
				button,
				state.open ? react.createElement(StallPanel, null) : null,
			)
		}

		/* ── plugin body ── */
		function apply(ctx) {
			activeLocale = ctx.locale.getSnapshot().active
			void refresh()
			ctx.effect(
				() => ctx.locale.subscribe(() => {
					activeLocale = ctx.locale.getSnapshot().active
					// Re-notify so projected text updates without re-registering.
					patch({})
				}),
				"session-watch: locale",
			)
			ctx.effect(() => {
				const timer = setInterval(() => { void refresh() }, POLL_MS)
				const onFocus = () => { void refresh() }
				window.addEventListener("focus", onFocus)
				return () => {
					clearInterval(timer)
					window.removeEventListener("focus", onFocus)
				}
			}, "session-watch: poll")

			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
				{
					name: "sidebar.footer.action",
					id: "session-watch",
					order: 6,
					label: () => tr("会话监视"),
				},
				WatchButton,
			))
		}

		exports.apply = apply
		exports.inject = ["slots", "locale"]
		return module.exports
	},
})
