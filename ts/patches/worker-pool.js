/**
 * OC Worker Pool Patch — worker_threads pool for offloading CPU-heavy JSON.
 *
 * This module is copied to OC's dist/ directory and loaded by the
 * compaction bundle. It creates a lazy-initialized worker pool that
 * offloads JSON.stringify, JSON.parse, transcript compaction, session
 * serialization, IPC transfer, and topic fan-out from the main event loop.
 *
 * Pool size: CPU count - 1 (leaves one core for main loop I/O)
 * Fallback: inline execution when all workers busy or if worker_threads fail
 *
 * Architecture (ticket #11 — handler-module registry):
 * Handler logic is authored exactly once, in the `handlers` map below. The
 * worker body is generic dispatch logic with the registry serialized in via
 * Function.prototype.toString; the inline fallback dispatches through the same
 * map directly. Adding a handler = one entry in `handlers` — no dispatch edits,
 * no duplicated if/else, no drift between the worker and inline paths.
 *
 * This fixes the prior god-function anti-pattern where the worker body and the
 * inline fallback each hand-maintained a parallel if/else over handler names.
 * That duplication had already drifted: the inline fallback was missing
 * `json.parse` entirely (silently returned null), `measure.size` used a
 * different implementation (.reduce vs for-loop), and unknown handlers rejected
 * in the worker but resolved null inline.
 *
 * Handlers:
 * - 'json.stringify' — JSON.stringify(input.data, input.replacer, input.indent)
 * - 'json.parse' — JSON.parse(input.text)
 * - 'compact.transcript' — join entries with newlines
 * - 'serialize.session' — stringify a session state (pass-through if already a string)
 * - 'ipc.transfer' — V8 structured clone transfer (pass-through payload)
 * - 'fanout.topics' — parallel topic fan-out payload formatting
 * - 'measure.size' — measure total JSON.stringify size of block arguments
 */

const { Worker } = require('node:worker_threads');
const os = require('node:os');

const MAX_THREADS = Math.max(1, os.cpus().length - 1);

let pool = null;
let activeCount = 0;
let completedCount = 0;
let failedCount = 0;

// Monotonic task counter — replaces non-deterministic Date.now()+Math.random()
// for worker task IDs. Deterministic, collision-free, and IC-friendly (monomorphic).
let taskCounter = 0;

// ── Handler registry (single source of truth) ─────────────────
// Pure, closure-free functions: (input) => result. Authored once; the worker
// body (serialized below) and the inline fallback both dispatch through this
// map, so handler logic is never duplicated. To add a handler: add one entry
// here (and, for the WorkerPool Protocol surface, one registerBuiltinHandlers
// entry in ts/src/features/worker-pool/handlers.ts). Handlers MUST be
// closure-free so Function.prototype.toString round-trips them into the worker.
const handlers = {
  'json.stringify': (input) => JSON.stringify(input.data, input.replacer, input.indent),
  'json.parse': (input) => JSON.parse(input.text),
  'compact.transcript': (input) => input.entries.map((e) => JSON.stringify(e)).join('\n'),
  'serialize.session': (input) => typeof input.session === 'string' ? input.session : JSON.stringify(input.session),
  'ipc.transfer': (input) => input.payload,
  'fanout.topics': (input) => {
    const serialized = typeof input.payload === 'string' ? input.payload : JSON.stringify(input.payload);
    const now = input.nowMs != null ? input.nowMs : Date.now();
    return input.topics.map((t) => ({ topic: t, payload: serialized, formattedAt: now }));
  },
  'measure.size': (input) => {
    let chars = 0;
    for (const b of input.blocks) chars += JSON.stringify(b.arguments || {}).length;
    return chars;
  },
};

/**
 * Inline dispatch — the fallback path (when all workers are busy) and the
 * test entry point. Throws on unknown handlers, matching the worker body, so
 * the two paths are consistent (the prior inline fallback silently returned
 * null for unknown/missing handlers).
 */
function dispatch(handler, input) {
  const fn = handlers[handler];
  if (typeof fn !== 'function') throw new Error('Unknown handler: ' + handler);
  return fn(input);
}

// ── Worker body (generic; registry serialized in) ─────────────
// Built from `handlers` + `dispatch` via Function.prototype.toString, so the
// worker thread runs the exact same handler logic as the inline path — no
// hand-maintained parallel copy. The worker is a stateless dispatcher: it
// looks up the handler by name in the registry and posts back the result.
const workerSource = `
const { parentPort } = require('node:worker_threads');
const handlers = {
${Object.entries(handlers).map(([name, fn]) => `  ${JSON.stringify(name)}: ${fn.toString()}`).join(',\n')}
};
${dispatch.toString()}
parentPort.on('message', ({ id, handler, input }) => {
  try {
    parentPort.postMessage({ id, ok: true, data: dispatch(handler, input) });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e.message });
  }
});
`;

function getPool() {
  if (pool) return pool;

  const workers = [];
  for (let i = 0; i < MAX_THREADS; i++) {
    const worker = new Worker(workerSource, { eval: true });
    workers.push({ worker, busy: false });
  }

  pool = {
    workers,
    execute(handler, input) {
      return new Promise((resolve, reject) => {
        const free = workers.find(w => !w.busy);
        if (free) {
          free.busy = true;
          activeCount++;
          const id = ++taskCounter;
          let timer = null;

          const cleanup = () => {
            if (timer) clearTimeout(timer);
            free.worker.off('message', handler_fn);
            free.busy = false;
            activeCount--;
          };

          const handler_fn = (msg) => {
            if (msg.id === id) {
              cleanup();
              completedCount++;
              if (msg.ok) resolve(msg.data);
              else reject(new Error(msg.error));
            }
          };

          // Task execution timeout (10s safety guard against worker hangs)
          timer = setTimeout(() => {
            cleanup();
            failedCount++;
            reject(new Error(`Worker execution timed out for handler: ${handler}`));
          }, 10000);

          free.worker.on('message', handler_fn);

          try {
            free.worker.postMessage({ id, handler, input });
          } catch (postErr) {
            cleanup();
            failedCount++;
            reject(postErr);
          }
        } else {
          // All workers busy — fallback to inline dispatch through the SAME
          // registry. No handler logic is duplicated; unknown handlers reject
          // (consistent with the worker path), not silently resolve null.
          try {
            const result = dispatch(handler, input);
            completedCount++;
            resolve(result);
          } catch (e) {
            failedCount++;
            reject(e);
          }
        }
      });
    },
    stats() {
      return { active: activeCount, completed: completedCount, failed: failedCount, poolSize: workers.length };
    }
  };

  return pool;
}

module.exports = { getPool, dispatch, handlers };
