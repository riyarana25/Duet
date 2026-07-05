/**
 * "Will it run?" — Python execution via Pyodide (real CPython compiled to WebAssembly),
 * sandboxed in a Web Worker.
 *
 * Why a worker: it has no DOM and no access to the page, runs off the main thread, and
 * can be hard-terminated — so an infinite loop costs the user a timeout, not the tab.
 * The worker stays warm between runs (the runtime is a ~10 MB one-time download from the
 * CDN, cached by the browser after that); a timed-out worker is discarded and a fresh
 * one is built for the next run.
 *
 * Requires network for the first load. Offline, the run reports a load failure honestly.
 */

export interface RunResult {
  logs: string[];
  error: string | null;
  durationMs: number;
}

export type RunStatus = 'loading' | 'running';

const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';

// Classic worker built from a Blob (no extra file to serve). stdout/stderr are captured
// into an array; the final expression's value (if any) is appended like a REPL would.
const WORKER_SRC = `
importScripts('${PYODIDE_URL}pyodide.js');
var ready = loadPyodide({ indexURL: '${PYODIDE_URL}' });
self.onmessage = async function (e) {
  var logs = [];
  try {
    var pyodide = await ready;
    pyodide.setStdout({ batched: function (s) { logs.push(s); } });
    pyodide.setStderr({ batched: function (s) { logs.push(s); } });
    self.postMessage({ type: 'running' });
    var t0 = Date.now();
    try {
      var result = await pyodide.runPythonAsync(e.data);
      if (result !== undefined && result !== null) logs.push('=> ' + String(result));
      self.postMessage({ type: 'result', logs: logs, error: null, durationMs: Date.now() - t0 });
    } catch (err) {
      self.postMessage({ type: 'result', logs: logs, error: String(err), durationMs: Date.now() - t0 });
    }
  } catch (err) {
    self.postMessage({ type: 'result', logs: [], error: 'failed to load the Python runtime (network?): ' + String(err), durationMs: 0 });
  }
};
`;

interface WorkerMsg extends Partial<RunResult> {
  type: 'running' | 'result';
}

// Warm worker reused across runs so Pyodide loads once per session.
let warm: Worker | null = null;
let warmUrl: string | null = null;

function getWorker(): Worker {
  if (warm) return warm;
  warmUrl = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
  warm = new Worker(warmUrl);
  return warm;
}

function discardWorker(): void {
  if (warm) warm.terminate();
  if (warmUrl) URL.revokeObjectURL(warmUrl);
  warm = null;
  warmUrl = null;
}

/**
 * Run `code` as Python. `onStatus` fires 'loading' immediately (meaningful on the first
 * run while the runtime downloads) and 'running' once execution actually starts; the
 * execution timeout is only armed at 'running', so a slow first load isn't punished.
 */
export function runPython(
  code: string,
  onStatus: (s: RunStatus) => void,
  execTimeoutMs = 5000,
  loadTimeoutMs = 90_000,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const worker = getWorker();
    let done = false;
    let timer: ReturnType<typeof setTimeout>;

    const finish = (result: RunResult, broken: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.onmessage = null;
      worker.onerror = null;
      if (broken) discardWorker(); // a terminated/errored worker can't be reused
      resolve(result);
    };

    onStatus('loading');
    timer = setTimeout(
      () => finish({ logs: [], error: 'the Python runtime took too long to load (network?)', durationMs: 0 }, true),
      loadTimeoutMs,
    );

    worker.onmessage = (e: MessageEvent<WorkerMsg>) => {
      if (e.data.type === 'running') {
        onStatus('running');
        clearTimeout(timer);
        timer = setTimeout(
          () =>
            finish(
              { logs: [], error: `timed out after ${execTimeoutMs / 1000}s — infinite loop?`, durationMs: execTimeoutMs },
              true,
            ),
          execTimeoutMs,
        );
        return;
      }
      finish(
        { logs: e.data.logs ?? [], error: e.data.error ?? null, durationMs: e.data.durationMs ?? 0 },
        false,
      );
    };
    worker.onerror = (e: ErrorEvent) => finish({ logs: [], error: e.message || 'worker error', durationMs: 0 }, true);

    worker.postMessage(code);
  });
}
