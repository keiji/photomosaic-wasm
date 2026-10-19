/**
 * 純 TypeScript 版エントリポイント。
 * WASM を使わず、TypeScript 実装のコアを Web Worker で実行する。
 * Worker 初期化に失敗した場合はメインスレッド版へフォールバックする。
 */
import type { CoreBridge } from './core/types';
import { createJsCore } from './core/jsCore';
import { createWorkerCoreBridge } from './core/workerBridge';
import { reportStartupFailure, startApp } from './app';

let implementation = 'js-worker';

async function createCore(): Promise<CoreBridge> {
  try {
    const core = await createWorkerCoreBridge('js');
    implementation = 'js-worker';
    return core;
  } catch (err) {
    console.warn('JS worker failed to initialize, falling back to main thread', err);
    implementation = 'js';
    return createJsCore();
  }
}

startApp(createCore, () => implementation).catch(reportStartupFailure);
