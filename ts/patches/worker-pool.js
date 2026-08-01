/**
 * OC Worker Pool Patch — worker_threads pool for offloading CPU-heavy JSON.
 *
 * This module is copied to OC's dist/ directory and loaded by the
 * compaction bundle. It creates a lazy-initialized worker pool that
 * offloads JSON.stringify, JSON.parse, and transcript compaction
 * from the main event loop.
 *
 * Pool size: CPU count - 1 (leaves one core for main loop I/O)
 * Fallback: inline execution when all workers busy or if worker_threads fail
 *
 * Handlers:
 * - 'json.stringify' — JSON.stringify(input.data, input.replacer, input.indent)
 * - 'json.parse' — JSON.parse(input.text)
 * - 'compact.transcript' — join entries with newlines
 * - 'measure.size' — measure total JSON.stringify size of blocks
 */

const { Worker } = require('node:worker_threads');
const os = require('node:os');

const MAX_THREADS = Math.max(1, os.cpus().length - 1);

let pool = null;
let activeCount = 0;
let completedCount = 0;
let failedCount = 0;

function getPool() {
  if (pool) return pool;

  const workers = [];
  for (let i = 0; i < MAX_THREADS; i++) {
    const worker = new Worker(`
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', ({ id, handler, input }) => {
        try {
          if (handler === 'json.stringify') {
            const result = JSON.stringify(input.data, input.replacer, input.indent);
            parentPort.postMessage({ id, ok: true, data: result });
          } else if (handler === 'json.parse') {
            const result = JSON.parse(input.text);
            parentPort.postMessage({ id, ok: true, data: result });
          } else if (handler === 'compact.transcript') {
            const result = input.entries.map(e => JSON.stringify(e)).join('\\n');
            parentPort.postMessage({ id, ok: true, data: result });
          } else if (handler === 'serialize.session') {
            const result = typeof input.session === 'string' ? input.session : JSON.stringify(input.session);
            parentPort.postMessage({ id, ok: true, data: result });
          } else if (handler === 'ipc.transfer') {
            // Direct V8 structured clone transfer — zero JSON stringification
            parentPort.postMessage({ id, ok: true, data: input.payload });
          } else if (handler === 'fanout.topics') {
            // Parallel topic fan-out serialization across worker pool
            const serialized = typeof input.payload === 'string' ? input.payload : JSON.stringify(input.payload);
            const now = Date.now();
            const results = input.topics.map(t => ({ topic: t, payload: serialized, formattedAt: now }));
            parentPort.postMessage({ id, ok: true, data: results });
          } else if (handler === 'measure.size') {
            let chars = 0;
            for (const b of input.blocks) {
              chars += JSON.stringify(b.arguments || {}).length;
            }
            parentPort.postMessage({ id, ok: true, data: chars });
          } else {
            parentPort.postMessage({ id, ok: false, error: 'Unknown handler: ' + handler });
          }
        } catch (e) {
          parentPort.postMessage({ id, ok: false, error: e.message });
        }
      });
    `, { eval: true });
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
          const id = Date.now() + Math.random();
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
          // All workers busy — fallback to inline
          try {
            activeCount++;
            let result;
            if (handler === 'json.stringify') {
              result = JSON.stringify(input.data, input.replacer, input.indent);
            } else if (handler === 'compact.transcript') {
              result = input.entries.map(e => JSON.stringify(e)).join('\n');
            } else if (handler === 'serialize.session') {
              result = typeof input.session === 'string' ? input.session : JSON.stringify(input.session);
            } else if (handler === 'ipc.transfer') {
              result = input.payload;
            } else if (handler === 'fanout.topics') {
              const serialized = typeof input.payload === 'string' ? input.payload : JSON.stringify(input.payload);
              const now = Date.now();
              result = input.topics.map(t => ({ topic: t, payload: serialized, formattedAt: now }));
            } else if (handler === 'measure.size') {
              result = input.blocks.reduce((acc, b) => acc + JSON.stringify(b.arguments || {}).length, 0);
            } else {
              result = null;
            }
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

module.exports = { getPool };
