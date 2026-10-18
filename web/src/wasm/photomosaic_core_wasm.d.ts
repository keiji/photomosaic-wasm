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
 * 部分結果(詳細設計書 3 章 ResultBatch / 7.4 の JS 輸出)。
 *
 * 行番号はブロック行(row_batch の単位)。画素行への写像は
 * `row_begin * block_size`。`rgba` は `width * (row_end - row_begin)
 * * block_size * 4` バイト(下端の半端ブロック行は画像端でクリップ)
 */
export class JsResultBatch {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * 1 ブロック行の高さ px(画素行への写像に使用)
     */
    readonly block_size: number;
    /**
     * 合成済み RGBA 行バッファ
     */
    readonly rgba: Uint8Array;
    /**
     * 完成したブロック行範囲 `[row_begin, row_end)`
     */
    readonly row_begin: number;
    readonly row_end: number;
    /**
     * 画像幅 px
     */
    readonly width: number;
}

/**
 * `step_run` 1 バッチ分の JS 輸出。
 *
 * `progress` / `result` は発火があった場合のみ非 `null`。JS 側は未使用の
 * イベント・部分結果オブジェクトを `free()` で解放する(寿命管理)
 */
export class JsStepOutput {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * 完了がキャンセルによるもの
     */
    readonly canceled: boolean;
    /**
     * 実行が完了(またはキャンセル)した
     */
    readonly done: boolean;
    /**
     * 発火した進捗イベント(onProgress スロットリング済み)。
     * 取り出し後は再度取得できない
     */
    readonly progress: JsProgressEvent | undefined;
    /**
     * 発火した部分結果(P4 合成バッチ)。取り出し後は再度取得できない
     */
    readonly result: JsResultBatch | undefined;
}

/**
 * タイル情報(詳細設計書 3 章 TileFeature の JS 輸出)
 */
export class JsTileInfo {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly detail: number;
    /**
     * アプリ側が採番したタイル ID(JS では bigint として扱う)
     */
    readonly id: bigint;
    /**
     * CIELAB 平均 (L*, a*, b*)
     */
    readonly mean_lab: Float32Array;
    readonly thumb_h: number;
    readonly thumb_w: number;
    readonly usage: number;
}

/**
 * 値の往復サンプル(handoff/02 検収基準: サンプル関数を JS から呼び値が往復すること)
 */
export function add(a: number, b: number): number;

/**
 * P2 タイル解析: タイル 1 枚を解析してタイルプールへ登録する。
 *
 * - `id`: アプリ側が採番したタイル ID(既存と重複する場合は置き換える)
 * - `feature_rgba`: 特徴量用サムネイル(32×32 固定。ホスト側でボックスフィルタ縮小済み)
 * - `compose_rgba`: 合成用サムネイル(長辺 64 上限、アスペクト維持。P4 合成用に保持)
 * - メモリガード超過時はエラーになり、プールは変更されない
 * - メイン画像設定済みの場合は差し替え評価の対象として記録し、
 *   次の差分再マッチ([`begin_rematch`])で追随する(M6)
 */
export function add_tile(id: bigint, feature_rgba: Uint8Array, compose_rgba: Uint8Array, compose_w: number, compose_h: number): JsTileInfo;

/**
 * 差分再マッチを開始する(M6: 詳細設計書 4.4 差分再マッチ / 7.5 要求の合流)。
 *
 * 現在の割当表とタイルプールの状態からモードを決定する:
 *
 * - 割当表が空(初回生成・ブロックサイズ変更後)→ 全ブロックをマッチする
 *   ([`begin_run`] と同一。未確定ブロック = 全ブロック)
 * - 未確定ブロックがある(タイル追加・削除後)→ 未確定ブロックのみマッチする
 * - 全ブロック確定済みでタイルが追加された → 差し替え評価のみ行う
 *   (現割当より `improve_margin` 以上良い候補がある場合に差し替える)
 * - 再マッチ不要(未確定なし・追加なし)→ 何もせず即時に完了する
 *
 * 使用回数 usage は開始時・完了時に現割当表から再集計する(4.4:
 * 「ペナルティの連続性を保つ」)。進捗・部分結果は run と同一の
 * [`step_run`] 駆動で得られる(差分再マッチも P3 として計上)
 */
export function begin_rematch(): void;

/**
 * フォトモザイクの P3(マッチング)+ P4(合成)を開始する(M5)。
 *
 * - メイン画像未設定・タイルプール空の場合はエラー(詳細設計書 6 章:
 *   タイルプール空での run は実行せず UI 層で案内する)
 * - 実行は行バッチ(row_batch 行)単位で進む。ホストは [`step_run`] を
 *   完了まで繰り返し呼び出し、バッチ境界で JS へ制御を返して
 *   UI 更新・進捗表示・部分描画を介在させる(詳細設計書 8.1)
 * - 使用回数 usage は開始時に正規化する(M4 と同一挙動)。
 *   差分再マッチ([`begin_rematch`])とは異なり全ブロックを再マッチする
 * - 進行中の別 run があれば破棄して新しく開始する
 */
export function begin_run(): void;

/**
 * フォトモザイクの実行をキャンセルする(詳細設計書 7.5)。
 *
 * キャンセルはバッチ境界で効く: 実行中の行バッチは完走したうえで停止する。
 * 既存のマッチ結果と現時点までの合成結果は保持され(exportImage の対象)、
 * 以降の `step_run` はエラーになる(呼び出し側はループを停止する)
 */
export function cancel(): void;

/**
 * メイン画像の状態を破棄する(リセット操作に対応。大容量バッファを開放する)
 */
export function clear_main_image(): void;

/**
 * タイルプールを空にする(リセット操作に対応。合成用サムネイルを解放する)
 */
export function clear_tiles(): void;

/**
 * 現時点の完成画像(または解析対象のメイン画像)RGBA を返す(P5 のエンコード前段)。
 * run 済みの場合は P4 合成結果を、未実行の場合は正規化後のメイン画像を返す
 * (詳細設計書 2 章 exportImage: 「完成画像(または現時点までの合成結果)」)。
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
 * 現在の設定(詳細設計書 5 章)を JSON 文字列で返す(詳細設計書 2 章 getConfig)
 */
export function get_config(): string;

/**
 * 登録済みタイル数(進捗の分母・UI の枚数表示に使用)
 */
export function get_tile_count(): number;

/**
 * 合成用サムネイルの合計バイト数(メモリガードの監視値。wasm32 では 4 GB 未満)
 */
export function get_tiles_memory_bytes(): number;

/**
 * コアバージョン(Web と Android で同一の .wasm を使うための整合確認用)
 */
export function get_version(): string;

/**
 * プールからタイルを削除する。
 *
 * 削除タイルが割当られていたブロックは未確定(None)に戻り、
 * 次の差分再マッチ([`begin_rematch`])で現プールから再割当てされる
 * (詳細設計書 4.4 差分再マッチ: タイル削除時)
 */
export function remove_tile(id: bigint): void;

/**
 * フォトモザイクのマッチング(P3)+ 合成(P4)を一括実行する(同期 API)。
 *
 * 内部では [`begin_run`] + [`step_run`](`None` 時刻)の行バッチ実行を
 * 完走させ、一括実行経路とバッチ実行経路が同一の結果になることを
 * 保証する。進捗イベント・部分結果の通知(M5 の主経路)が必要な場合は
 * begin/step/cancel のペアを使用する
 */
export function run(): void;

/**
 * P1 再実行: ブロックサイズを変更してグリッド・ブロック特徴量を再計算する
 *
 * 基本設計書 3.3: グリッド再計算 → 全ブロック再マッチ → 再合成。
 * タイル特徴量はブロックサイズに依存しないため P2 は再実行しない(キャッシュ再利用)。
 * 割当表は全ブロック未確定に戻る(次の run で全ブロック再マッチになる)
 */
export function set_block_size(px: number): JsGridInfo;

/**
 * 設定 JSON でパラメータを上書きする(詳細設計書 2 章 setConfig)。
 * すべてのフィールドが必須。詳細設計書 5 章の範囲外はエラーになる
 */
export function set_config(json: string): void;

/**
 * P1 メイン画像解析: グリッド計算とブロック特徴量を計算し、コア内に保持する。
 *
 * `rgba` は R→G→B→A 順・行優先・非プリマルチプライ・sRGB の 1 ピクセル 4 バイト。
 * ブロックサイズはコア既定値(24px)で計算し、変更は [`set_block_size`] で行う。
 */
export function set_main_image(rgba: Uint8Array, width: number, height: number): JsGridInfo;

/**
 * フォトモザイクの実行を 1 行バッチぶん進める(M5)。
 *
 * - `now_ms` はホストの時刻(起点は不問)。コア内部のスロットリング
 *   (16ms 以上または全体進捗 1% 以上の変化で発火。詳細設計書 7.2)に
 *   使用する。ダミー時間を用いた決定性テストには `None` や固定値も渡せる
 * - 戻り値はこのバッチで発火した進捗イベントと部分結果(行範囲の RGBA)、
 *   および完了フラグ。完了(`done == true`)時は合成結果が内部に確定し、
 *   以降 `export_main_image` で取得できる
 * - 進行中の run がない場合はエラーになる
 */
export function step_run(now_ms?: number | null): JsStepOutput;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_jsgridinfo_free: (a: number, b: number) => void;
    readonly __wbg_jsprogressevent_free: (a: number, b: number) => void;
    readonly __wbg_jsresultbatch_free: (a: number, b: number) => void;
    readonly __wbg_jsstepoutput_free: (a: number, b: number) => void;
    readonly __wbg_jstileinfo_free: (a: number, b: number) => void;
    readonly add: (a: number, b: number) => number;
    readonly add_tile: (a: number, b: bigint, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly begin_rematch: (a: number) => void;
    readonly begin_run: (a: number) => void;
    readonly cancel: () => void;
    readonly clear_main_image: () => void;
    readonly clear_tiles: () => void;
    readonly export_main_image: (a: number) => void;
    readonly get_block_mean_colors: (a: number) => void;
    readonly get_config: (a: number) => void;
    readonly get_tile_count: () => number;
    readonly get_tiles_memory_bytes: () => number;
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
    readonly jsresultbatch_block_size: (a: number) => number;
    readonly jsresultbatch_rgba: (a: number, b: number) => void;
    readonly jsresultbatch_row_begin: (a: number) => number;
    readonly jsresultbatch_row_end: (a: number) => number;
    readonly jsresultbatch_width: (a: number) => number;
    readonly jsstepoutput_canceled: (a: number) => number;
    readonly jsstepoutput_done: (a: number) => number;
    readonly jsstepoutput_progress: (a: number) => number;
    readonly jsstepoutput_result: (a: number) => number;
    readonly jstileinfo_detail: (a: number) => number;
    readonly jstileinfo_id: (a: number) => bigint;
    readonly jstileinfo_mean_lab: (a: number, b: number) => void;
    readonly jstileinfo_thumb_h: (a: number) => number;
    readonly jstileinfo_thumb_w: (a: number) => number;
    readonly jstileinfo_usage: (a: number) => number;
    readonly remove_tile: (a: number, b: bigint) => void;
    readonly run: (a: number) => void;
    readonly set_block_size: (a: number, b: number) => void;
    readonly set_config: (a: number, b: number, c: number) => void;
    readonly set_main_image: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly step_run: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
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
