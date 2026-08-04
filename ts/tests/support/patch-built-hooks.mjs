/**
 * Patch the BUILT OC hook runner (dist/hook-runner-global-*.js) to add the
 * same trace instrumentation as source patch 0001.
 *
 * This runs INSIDE the container after `npm install openclaw`, before
 * `gateway start`. It finds the built hook-runner chunk by glob, applies
 * the trace instrumentation via string replacement, and writes it back.
 *
 * The built code is readable (tsdown doesn't minify), so string replacement
 * is reliable. The patch is opt-in: trace events are only captured when
 * OPENCLAW_HOOK_DEBUG=1 or enableTrace is passed to createHookRunner.
 *
 * Usage: node /tmp/patch-built-hooks.mjs [node_modules/openclaw/dist]
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const distDir = resolve(process.argv[2] ?? "node_modules/openclaw/dist");

// Find the hook-runner-global chunk (hash in filename) that contains createHookRunner.
const files = readdirSync(distDir).filter(
  (f) => f.startsWith("hook-runner-global-") && f.endsWith(".js"),
).filter((f) => {
  // Only patch the chunk that actually contains createHookRunner (the other
  // is a 1-line re-export stub).
  return readFileSync(join(distDir, f), "utf8").includes("function createHookRunner");
});
if (files.length === 0) {
  console.error("[patch-built-hooks] hook-runner-global-*.js not found in " + distDir);
  process.exit(1);
}
if (files.length > 1) {
  console.error("[patch-built-hooks] multiple matches: " + files.join(", "));
  process.exit(1);
}

const filePath = join(distDir, files[0]);
let src = readFileSync(filePath, "utf8");
const original = src;

// ── 1. Add appendFileSync import ──────────────────────────────────────────
if (!src.includes("appendFileSync")) {
  src = src.replace(
    /^(import .*?;)/m,
    `$1\nimport { appendFileSync } from "node:fs";`,
  );
}

// ── 2. Add trace infrastructure after catchErrors ─────────────────────────
const oldCatch = "const catchErrors = options.catchErrors ?? true;";
const newCatch = `const catchErrors = options.catchErrors ?? true;
	const enableTrace = options.enableTrace ?? process.env.OPENCLAW_HOOK_DEBUG === "1";
	const traceFile = process.env.OPENCLAW_HOOK_TRACE_FILE;
	const traceEvents = [];
	const captureTrace = (event) => {
		if (enableTrace) {
			const fullEvent = { ts: Date.now(), ...event };
			traceEvents.push(fullEvent);
			if (traceFile) {
				try { appendFileSync(traceFile, JSON.stringify(fullEvent) + "\\n"); } catch {}
			}
		}
	};`;

if (!src.includes("captureTrace")) {
  src = src.replace(oldCatch, newCatch, 1);
}

// ── 3. Instrument handleHookError ─────────────────────────────────────────
const oldErr = `const handleHookError = (params) => {
		const msg = \`[hooks] \${params.hookName} handler from \${params.pluginId} failed: \${formatHookErrorForLog(params.error)}\`;
		if (shouldCatchHookErrors(params.hookName)) {
			logger?.error(msg);
			return;
		}
		throw new Error(msg, { cause: params.error });
	};`;

const newErr = `const handleHookError = (params) => {
		const msg = \`[hooks] \${params.hookName} handler from \${params.pluginId} failed: \${formatHookErrorForLog(params.error)}\`;
		const swallowed = shouldCatchHookErrors(params.hookName);
		captureTrace({ type: "error", hookName: params.hookName, pluginId: params.pluginId, error: sanitizeHookError(params.error), swallowed });
		if (swallowed) {
			logger?.error(msg);
			return;
		}
		throw new Error(msg, { cause: params.error });
	};`;

if (src.includes(oldErr) && !src.includes("captureTrace({ type: \"error\"")) {
  src = src.replace(oldErr, newErr, 1);
}

// ── 4. Instrument all no-handlers returns ─────────────────────────────────
// Pattern 1: if (hooks.length === 0) return;  (void/modifying/claiming hooks)
const oldNoHandlers = "if (hooks.length === 0) return;";
const newNoHandlers = `if (hooks.length === 0) { captureTrace({ type: "no-handlers", hookName, reason: registry.typedHooks.filter((h) => h.hookName === hookName).length > 0 ? "filtered-out" : "not-registered" }); return; }`;
src = src.split(oldNoHandlers).join(newNoHandlers);

// Pattern 2: if (hooks.length === 0) return { status: "no_handler" };
const oldNoHandler = 'if (hooks.length === 0) return { status: "no_handler" };';
const newNoHandler = `if (hooks.length === 0) { captureTrace({ type: "no-handlers", hookName, reason: "not-registered" }); return { status: "no_handler" }; }`;
src = src.split(oldNoHandler).join(newNoHandler);

// ── 4b. Add dispatch traces (after debug log lines) ───────────────────────
// When hooks fire normally (hooks.length > 0), capture a dispatch event so
// the trace records the full lifecycle (not just errors/no-handlers).
// Must replace the FULL statement (including logger?.debug?. wrapper + semicolon)
// to avoid inserting a semicolon inside the function call.
const dispatchPatterns = [
  'logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers)`);',
  'logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers, sequential)`);',
  'logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers, first-claim wins)`);',
  'logger?.debug?.(`[hooks] running ${hookName} (${hooks.length} handlers, attributed)`);',
];
let dispatchMatchCount = 0;
for (const pattern of dispatchPatterns) {
  const count = src.split(pattern).length - 1;
  dispatchMatchCount += count;
  src = src.split(pattern).join(pattern + ' captureTrace({ type: "dispatch", hookName, handlerCount: hooks.length });');
}
console.log(`[patch-built-hooks] dispatch pattern matches: ${dispatchMatchCount}`);

// ── 5. Add getTrace/clearTrace to the return value ────────────────────────
const oldReturn = "hasHooks,\n\t\tgetHookCount\n\t};";
const newReturn = "hasHooks,\n\t\tgetHookCount,\n\t\tgetTrace: () => traceEvents,\n\t\tclearTrace: () => { traceEvents.length = 0; }\n\t};";
src = src.split(oldReturn).join(newReturn);

// ── Write back ────────────────────────────────────────────────────────────
// ── Report match statistics ─────────────────────────────────────────────
const noHandlersCount = (original.split("if (hooks.length === 0) return;").length - 1) + (original.split('if (hooks.length === 0) return { status: "no_handler" };').length - 1);
console.log(`[patch-built-hooks] no-handlers pattern matches: ${noHandlersCount}`);
console.log(`[patch-built-hooks] error handler match: ${original.includes(oldErr) ? "yes" : "no"}`);

if (src === original) {
  console.error("[patch-built-hooks] WARNING: no changes were made — the built code structure may have changed.");
  process.exit(1);
}

writeFileSync(filePath, src, "utf8");
console.log(`[patch-built-hooks] patched ${files[0]} (+${src.length - original.length} chars)`);
