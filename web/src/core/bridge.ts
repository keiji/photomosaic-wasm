/**
 * コア呼び出しラッパ。
 *
 * handoff/04(M1): ビルド〜配信〜呼び出し〜進捗コールバックの経路を本物にする。
 * - wasm-pack 生成物(web/src/wasm/)を動的ロードする(ロードは 1 回のみ)
 * - ロードに失敗した環境では M0 のモックへフォールバックする(UI 開発をブロックしない)
 * - メイン画像系の処理(グリッド計算)は M2 でコアへ移行するまでモックの計算を共用する
 */
import { createMockCore } from './mockCore';
import type { CoreBridge, ProgressCallback, ProgressEvent } from './types';

/** コア実装の種類(デバッグ表示用) */
export type CoreImplementation = 'mock' | 'wasm';

let currentImplementation: CoreImplementation = 'mock';

export function getCoreImplementation(): CoreImplementation {
  return currentImplementation;
}

/** WASM 実装をロードして構築する(失敗時は例外を投げ、呼び出し側でモックへフォールバック) */
async function createWasmCore(): Promise<CoreBridge> {
  const wasm = await import('../wasm/photomosaic_core_wasm.js');
  await wasm.default();
  // 初期化が済んだことを往復サンプルで確認する(handoff/02 検収基準)
  wasm.add(1, 1);

  const mock = createMockCore(); // グリッド計算は M2 までモックを共用
  const progressListeners = new Set<ProgressCallback>();
  const emit = (event: ProgressEvent): void => {
    for (const listener of progressListeners) {
      listener(event);
    }
  };

  return {
    async getVersion(): Promise<string> {
      return wasm.get_version();
    },

    setMainImage: mock.setMainImage,
    setBlockSize: mock.setBlockSize,
    exportImage: mock.exportImage,

    onProgress(callback: ProgressCallback): void {
      progressListeners.add(callback);
    },

    runProgressDemo(durationMs = 1000): Promise<void> {
      if (durationMs <= 0) {
        return Promise.resolve();
      }
      // コア(Rust)のスロットラーが発火を判定し、発火したバッチだけ UI へ届く。
      // JS の setInterval はバッチ境界の駆動役(M5 でコア駆動の本実装に置き換わる)
      const demo = new wasm.ProgressDemo(1000);
      const start = performance.now();
      return new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setInterval> | null = null;
        const step = (): void => {
          const elapsed = performance.now() - start;
          const ratio = Math.min(1, elapsed / durationMs);
          const event = demo.tick(elapsed, ratio);
          if (event !== undefined) {
            emit({
              phaseCode: event.phase_code,
              phaseRatio: event.phase_ratio,
              overallRatio: event.overall_ratio,
              assignedBlocks: event.assigned_blocks,
              totalBlocks: event.total_blocks,
            });
            event.free();
          }
          if (ratio >= 1) {
            if (timer !== null) {
              clearInterval(timer);
              timer = null;
            }
            demo.free();
            resolve();
          }
        };
        step(); // 開始時点(0%)を即時に通知する
        timer = setInterval(step, 16);
      });
    },
  };
}

/** WASM 初期化の結果をキャッシュする(1 回だけ試行。失敗時はモックへフォールバック) */
let wasmInit: Promise<CoreBridge> | null = null;

/**
 * コアブリッジを生成する。
 * WASM のロードに成功したら実装('wasm')を返し、失敗したらモック('mock')に
 * フォールバックする。実装の種類は getCoreImplementation() で確認できる。
 */
export async function createCoreBridge(): Promise<CoreBridge> {
  if (wasmInit === null) {
    wasmInit = createWasmCore()
      .then((core) => {
        currentImplementation = 'wasm';
        return core;
      })
      .catch((err: unknown) => {
        console.warn('WASM core failed to load, falling back to mock core', err);
        currentImplementation = 'mock';
        wasmInit = null; // 次回の呼び出しで再試行できるようにする
        return createMockCore();
      });
  }
  return wasmInit;
}
