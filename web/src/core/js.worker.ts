/**
 * 純 TypeScript コア専用 Worker。
 * メインスレッドの rAF を使わず、行バッチ実行を Worker 内で進める。
 */
import { createJsCore } from './jsCore';
import { startWorker } from './workerRuntime';

startWorker(async (options) => createJsCore(options));
