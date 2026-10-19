/**
 * WASM 版エントリポイント。
 * WASM コアを Web Worker で実行し、Worker 初期化に失敗した場合は
 * メインスレッド版(WASM → モック)へフォールバックする。
 */
import type { CoreBridge } from './core/types';
import { createCoreBridge, getCoreImplementation } from './core/bridge';
import { createWorkerCoreBridge } from './core/workerBridge';
import { reportStartupFailure, startApp } from './app';

let implementation = 'wasm-worker';

async function createCore(): Promise<CoreBridge> {
  try {
    const core = await createWorkerCoreBridge('wasm');
    implementation = 'wasm-worker';
    return core;
  } catch (err) {
    console.warn('WASM worker failed to initialize, falling back to main thread', err);
    const core = await createCoreBridge();
    implementation = getCoreImplementation();
    return core;
  }
}

startApp(createCore, () => implementation).catch(reportStartupFailure);
