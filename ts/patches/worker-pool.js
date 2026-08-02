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
 * Crash isolation & respawn (ticket #13): each worker owns 'error'/'exit'
 * listeners that reject any in-flight task immediately (the 'message' listener
 * never fires on a dead thread), retire the slot, and spawn a replacement to
 * hold the target thread count. This fixes the prior dead-slot degradation
 * where a crashed worker stayed in the rotation, was re-selected, and wasted
 * its slot until the 10s watchdog — and the watchdog only rejected, never
 * restored the slot, so a death permanently shrank the pool until process
 * restart.
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
  let deadWorkers = 0;

  // ── Slot lifecycle (ticket #13 — crash isolation & respawn) ──────────
  // A slot bundles one worker thread with its in-flight task state. The
  // worker's 'error' and 'exit' listeners are the only code path that can
  // reject an in-flight task when the thread dies: the 'message' listener
  // never fires on a dead thread, so without these the task would hang until
  // the 10s watchdog — and the watchdog only rejected, it never restored the
  // slot, so a death permanently shrank the pool. On death we: reject the
  // in-flight task at once, retire the slot from the rotation, and spawn a
  // replacement so the target thread count holds. The 'dead' flag makes
  // die() idempotent — 'error' and 'exit' can both fire for one death.
  function createSlot() {
    const slot = { worker: null, busy: false, current: null, dead: false };
    slot.worker = new Worker(workerSource, { eval: true });

    const die = (reason) => {
      if (slot.dead) return; // handle once even if both 'error' and 'exit' fire
      slot.dead = true;
      deadWorkers++;

      // Reject the in-flight task immediately (no 10s wait). An idle worker
      // (no current task) just retires and respawns.
      const cur = slot.current;
      if (cur) {
        if (cur.timer) clearTimeout(cur.timer);
        activeCount--;
        failedCount++;
        cur.reject(new Error('Worker thread terminated: ' + reason));
      }

      // Retire the slot, then hold the target thread count with a replacement
      // so a death never permanently shrinks the pool. (Auto-respawn is
      // bounded by the caller's task rate; systematic kill-loops are a #14
      // backpressure concern, not handled here.)
      const idx = workers.indexOf(slot);
      if (idx !== -1) workers.splice(idx, 1);
      if (workers.length < MAX_THREADS) workers.push(createSlot());
    };

    slot.worker.on('error', (e) => die('error: ' + e.message));
    slot.worker.on('exit', (code) => die('exit code ' + code));
    return slot;
  }

  for (let i = 0; i < MAX_THREADS; i++) workers.push(createSlot());

  pool = {
    workers,
    execute(handler, input) {
      return new Promise((resolve, reject) => {
        const free = workers.find(w => !w.busy && !w.dead);
        if (free) {
          free.busy = true;
          activeCount++;
          const id = ++taskCounter;

          // finish() is the single settle path for the message and watchdog
          // outcomes. It is a no-op if the slot already died — die() settled
          // the task via the exit listener and cleared the timer that could
          // call finish() — so message, watchdog, and death never
          // double-settle the same task.
          function finish(outcome) {
            if (free.dead) return;
            if (free.current && free.current.timer) clearTimeout(free.current.timer);
            free.worker.off('message', onMessage);
            free.busy = false;
            free.current = null;
            activeCount--;
            if (outcome.ok) { completedCount++; resolve(outcome.value); }
            else { failedCount++; reject(outcome.error); }
          }

          function onMessage(msg) {
            if (msg.id !== id) return;
            if (msg.ok) finish({ ok: true, value: msg.data });
            else finish({ ok: false, error: new Error(msg.error) });
          }

          // current holds the in-flight task so die() can reject it from the
          // exit listener. The watchdog is the last-resort guard for a worker
          // that hangs without dying (neither 'message' nor 'exit' fires);
          // crash death is handled faster by die().
          free.current = { id: id, resolve: resolve, reject: reject, timer: null };
          free.current.timer = setTimeout(
            function () { finish({ ok: false, error: new Error('Worker execution timed out for handler: ' + handler) }); },
            10000,
          );

          free.worker.on('message', onMessage);

          try {
            free.worker.postMessage({ id: id, handler: handler, input: input });
          } catch (postErr) {
            finish({ ok: false, error: postErr });
          }
        } else {
          // All workers busy — inline fallback through the SAME registry (#11).
          // No handler logic is duplicated; unknown handlers reject
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
      return {
        active: activeCount,
        completed: completedCount,
        failed: failedCount,
        poolSize: workers.length,
        deadWorkers: deadWorkers,
      };
    }
  };

  return pool;
}

module.exports = { getPool, dispatch, handlers };
