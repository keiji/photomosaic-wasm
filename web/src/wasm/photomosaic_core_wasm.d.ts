/* tslint:disable */
/* eslint-disable */

/**
 * グリッド情報(詳細設計書 3 章 GridInfo の JS 輸出)
 */
export class JsGridInfo {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly block_size: number;
    readonly cols: number;
    readonly height: number;
    readonly rows: number;
    readonly total_blocks: number;
    readonly width: number;
}

/**
 * UI 表示用の進捗イベント(文言は持たず、安定識別子 `phase_code` のみ。詳細設計書 7.2)
 */
export class JsProgressEvent {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly assigned_blocks: number;
    readonly overall_ratio: number;
    readonly phase_code: string;
    readonly phase_ratio: number;
    readonly total_blocks: number;
}

/**
 * 進捗デモ用のスロットル判定(ダミー処理を 16ms 間隔のバッチに区切って進める)。
 *
 * JS 側のタイマーから現在時刻とダミー処理の進行率を渡すと、コア内の
 * [`ProgressThrottle`] が「16ms 以上の経過」または「1% 以上の変化」を判定し、
 * 発火すべきときだけ進捗イベントを返す(発火不要のときは `None`)。
 *
 * 戻り値は `ResultBatch` の部分ではなく、UI 表示に必要なフィールドのみ。
 */
export class ProgressDemo {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * ダミー処理(M3 相当のマッチング)を想定した進捗デモを初期化する
     */
    constructor(total_blocks: number);
    /**
     * 現在時刻 `now_ms` と進行率 `ratio`(0.0..1.0)を渡し、
     * 発火すべきときだけ [`JsProgressEvent`] を返す。
     */
    tick(now_ms: number, ratio: number): JsProgressEvent | undefined;
}

/**
 * 値の往復サンプル(handoff/02 検収基準: サンプル関数を JS から呼び値が往復すること)
 */
export function add(a: number, b: number): number;

/**
 * メイン画像の状態を破棄する(リセット操作に対応。大容量バッファを開放する)
 */
export function clear_main_image(): void;

/**
 * 現時点の完成画像(または解析対象のメイン画像)RGBA を返す(P5 のエンコード前段)。
 * コア内バッファを 1 回だけ取り出す設計に対応し、M4 で合成結果の返却に差し替わる。
 */
export function export_main_image(): Uint8Array;

/**
 * プレビュー描画用のブロック平均色を返す。
 *
 * 各ブロックの mean_lab(CIELAB)を sRGB 8bit へ逆変換し、
 * RGB 3 バイト × ブロック数(行優先)のバイト列として返す。
 * メイン画像未設定時は空の配列を返す(論理 API の契約)。
 */
export function get_block_mean_colors(): Uint8Array;

/**
 * コアバージョン(Web と Android で同一の .wasm を使うための整合確認用)
 */
export function get_version(): string;

/**
 * P1 再実行: ブロックサイズを変更してグリッド・ブロック特徴量を再計算する
 */
export function set_block_size(px: number): JsGridInfo;

/**
 * P1 メイン画像解析: グリッド計算とブロック特徴量を計算し、コア内に保持する。
 *
 * `rgba` は R→G→B→A 順・行優先・非プリマルチプライ・sRGB の 1 ピクセル 4 バイト。
 * ブロックサイズはコア既定値(24px)で計算し、変更は [`set_block_size`] で行う。
 */
export function set_main_image(rgba: Uint8Array, width: number, height: number): JsGridInfo;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_jsgridinfo_free: (a: number, b: number) => void;
    readonly __wbg_jsprogressevent_free: (a: number, b: number) => void;
    readonly __wbg_progressdemo_free: (a: number, b: number) => void;
    readonly add: (a: number, b: number) => number;
    readonly clear_main_image: () => void;
    readonly export_main_image: (a: number) => void;
    readonly get_block_mean_colors: (a: number) => void;
    readonly get_version: (a: number) => void;
    readonly jsgridinfo_block_size: (a: number) => number;
    readonly jsgridinfo_cols: (a: number) => number;
    readonly jsgridinfo_height: (a: number) => number;
    readonly jsgridinfo_rows: (a: number) => number;
    readonly jsgridinfo_total_blocks: (a: number) => number;
    readonly jsgridinfo_width: (a: number) => number;
    readonly jsprogressevent_assigned_blocks: (a: number) => number;
    readonly jsprogressevent_overall_ratio: (a: number) => number;
    readonly jsprogressevent_phase_code: (a: number, b: number) => void;
    readonly jsprogressevent_phase_ratio: (a: number) => number;
    readonly jsprogressevent_total_blocks: (a: number) => number;
    readonly progressdemo_new: (a: number) => number;
    readonly progressdemo_tick: (a: number, b: number, c: number) => number;
    readonly set_block_size: (a: number, b: number) => void;
    readonly set_main_image: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export2: (a: number, b: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
