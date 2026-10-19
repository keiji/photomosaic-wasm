/**
 * WASM コア専用 Worker。
 * メインスレッドの rAF を使わず、WASM の行バッチ実行を Worker 内で進める。
 */
import { createWasmCore } from './bridge';
import { startWorker } from './workerRuntime';

startWorker((options) => createWasmCore(options));
