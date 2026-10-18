/**
 * コア呼び出しラッパ。
 *
 * handoff/04(2 章)のモック方針: コア未完成の間は同じ論理 API を持つ
 * TypeScript モックを差し替え先として使い、UI 開発をブロックしない。
 * M1 で WASM ロード・メモリ管理・コールバック登録を実装し、
 * 本関数の戻り値を実装に差し替える。
 */
import { createMockCore } from './mockCore';
import type { CoreBridge } from './types';

/** コア実装の種類(デバッグ表示用) */
export type CoreImplementation = 'mock' | 'wasm';

let currentImplementation: CoreImplementation = 'mock';

export function getCoreImplementation(): CoreImplementation {
  return currentImplementation;
}

/**
 * コアブリッジを生成する。
 * M0 は常にモックを返す。M1 以降はここで WASM を初期化する。
 */
export async function createCoreBridge(): Promise<CoreBridge> {
  // M1 以降: WASM モジュールのロードと初期化を行い、
  // バインディングをラップする実装を返す。
  currentImplementation = 'mock';
  return createMockCore();
}
