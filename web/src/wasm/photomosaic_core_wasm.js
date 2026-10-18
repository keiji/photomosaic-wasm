/* @ts-self-types="./photomosaic_core_wasm.d.ts" */

/**
 * グリッド情報(詳細設計書 3 章 GridInfo の JS 輸出)
 */
export class JsGridInfo {
    static __wrap(ptr) {
        const obj = Object.create(JsGridInfo.prototype);
        obj.__wbg_ptr = ptr;
        JsGridInfoFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JsGridInfoFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_jsgridinfo_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get block_size() {
        const ret = wasm.jsgridinfo_block_size(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get cols() {
        const ret = wasm.jsgridinfo_cols(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get height() {
        const ret = wasm.jsgridinfo_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get rows() {
        const ret = wasm.jsgridinfo_rows(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get total_blocks() {
        const ret = wasm.jsgridinfo_total_blocks(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get width() {
        const ret = wasm.jsgridinfo_width(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) JsGridInfo.prototype[Symbol.dispose] = JsGridInfo.prototype.free;

/**
 * UI 表示用の進捗イベント(文言は持たず、安定識別子 `phase_code` のみ。詳細設計書 7.2)
 */
export class JsProgressEvent {
    static __wrap(ptr) {
        const obj = Object.create(JsProgressEvent.prototype);
        obj.__wbg_ptr = ptr;
        JsProgressEventFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JsProgressEventFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_jsprogressevent_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get assigned_blocks() {
        const ret = wasm.jsprogressevent_assigned_blocks(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get overall_ratio() {
        const ret = wasm.jsprogressevent_overall_ratio(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {string}
     */
    get phase_code() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.jsprogressevent_phase_code(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get phase_ratio() {
        const ret = wasm.jsprogressevent_phase_ratio(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get total_blocks() {
        const ret = wasm.jsprogressevent_total_blocks(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) JsProgressEvent.prototype[Symbol.dispose] = JsProgressEvent.prototype.free;

/**
 * 部分結果(詳細設計書 3 章 ResultBatch / 7.4 の JS 輸出)。
 *
 * 行番号はブロック行(row_batch の単位)。画素行への写像は
 * `row_begin * block_size`。`rgba` は `width * (row_end - row_begin)
 * * block_size * 4` バイト(下端の半端ブロック行は画像端でクリップ)
 */
export class JsResultBatch {
    static __wrap(ptr) {
        const obj = Object.create(JsResultBatch.prototype);
        obj.__wbg_ptr = ptr;
        JsResultBatchFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JsResultBatchFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_jsresultbatch_free(ptr, 0);
    }
    /**
     * 1 ブロック行の高さ px(画素行への写像に使用)
     * @returns {number}
     */
    get block_size() {
        const ret = wasm.jsresultbatch_block_size(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 合成済み RGBA 行バッファ
     * @returns {Uint8Array}
     */
    get rgba() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.jsresultbatch_rgba(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * 完成したブロック行範囲 `[row_begin, row_end)`
     * @returns {number}
     */
    get row_begin() {
        const ret = wasm.jsresultbatch_row_begin(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get row_end() {
        const ret = wasm.jsresultbatch_row_end(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 画像幅 px
     * @returns {number}
     */
    get width() {
        const ret = wasm.jsresultbatch_width(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) JsResultBatch.prototype[Symbol.dispose] = JsResultBatch.prototype.free;

/**
 * `step_run` 1 バッチ分の JS 輸出。
 *
 * `progress` / `result` は発火があった場合のみ非 `null`。JS 側は未使用の
 * イベント・部分結果オブジェクトを `free()` で解放する(寿命管理)
 */
export class JsStepOutput {
    static __wrap(ptr) {
        const obj = Object.create(JsStepOutput.prototype);
        obj.__wbg_ptr = ptr;
        JsStepOutputFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JsStepOutputFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_jsstepoutput_free(ptr, 0);
    }
    /**
     * 完了がキャンセルによるもの
     * @returns {boolean}
     */
    get canceled() {
        const ret = wasm.jsstepoutput_canceled(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * 実行が完了(またはキャンセル)した
     * @returns {boolean}
     */
    get done() {
        const ret = wasm.jsstepoutput_done(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * 発火した進捗イベント(onProgress スロットリング済み)。
     * 取り出し後は再度取得できない
     * @returns {JsProgressEvent | undefined}
     */
    get progress() {
        const ret = wasm.jsstepoutput_progress(this.__wbg_ptr);
        return ret === 0 ? undefined : JsProgressEvent.__wrap(ret);
    }
    /**
     * 発火した部分結果(P4 合成バッチ)。取り出し後は再度取得できない
     * @returns {JsResultBatch | undefined}
     */
    get result() {
        const ret = wasm.jsstepoutput_result(this.__wbg_ptr);
        return ret === 0 ? undefined : JsResultBatch.__wrap(ret);
    }
}
if (Symbol.dispose) JsStepOutput.prototype[Symbol.dispose] = JsStepOutput.prototype.free;

/**
 * タイル情報(詳細設計書 3 章 TileFeature の JS 輸出)
 */
export class JsTileInfo {
    static __wrap(ptr) {
        const obj = Object.create(JsTileInfo.prototype);
        obj.__wbg_ptr = ptr;
        JsTileInfoFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JsTileInfoFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_jstileinfo_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get detail() {
        const ret = wasm.jstileinfo_detail(this.__wbg_ptr);
        return ret;
    }
    /**
     * アプリ側が採番したタイル ID(JS では bigint として扱う)
     * @returns {bigint}
     */
    get id() {
        const ret = wasm.jstileinfo_id(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * CIELAB 平均 (L*, a*, b*)
     * @returns {Float32Array}
     */
    get mean_lab() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.jstileinfo_mean_lab(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {number}
     */
    get thumb_h() {
        const ret = wasm.jstileinfo_thumb_h(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get thumb_w() {
        const ret = wasm.jstileinfo_thumb_w(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get usage() {
        const ret = wasm.jstileinfo_usage(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) JsTileInfo.prototype[Symbol.dispose] = JsTileInfo.prototype.free;

/**
 * 値の往復サンプル(handoff/02 検収基準: サンプル関数を JS から呼び値が往復すること)
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function add(a, b) {
    const ret = wasm.add(a, b);
    return ret;
}

/**
 * P2 タイル解析: タイル 1 枚を解析してタイルプールへ登録する。
 *
 * - `id`: アプリ側が採番したタイル ID(既存と重複する場合は置き換える)
 * - `feature_rgba`: 特徴量用サムネイル(32×32 固定。ホスト側でボックスフィルタ縮小済み)
 * - `compose_rgba`: 合成用サムネイル(長辺 64 上限、アスペクト維持。P4 合成用に保持)
 * - メモリガード超過時はエラーになり、プールは変更されない
 * - メイン画像設定済みの場合は差し替え評価の対象として記録し、
 *   次の差分再マッチ([`begin_rematch`])で追随する(M6)
 * @param {bigint} id
 * @param {Uint8Array} feature_rgba
 * @param {Uint8Array} compose_rgba
 * @param {number} compose_w
 * @param {number} compose_h
 * @returns {JsTileInfo}
 */
export function add_tile(id, feature_rgba, compose_rgba, compose_w, compose_h) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(feature_rgba, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(compose_rgba, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        wasm.add_tile(retptr, id, ptr0, len0, ptr1, len1, compose_w, compose_h);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        if (r2) {
            throw takeObject(r1);
        }
        return JsTileInfo.__wrap(r0);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

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
export function begin_rematch() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.begin_rematch(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        if (r1) {
            throw takeObject(r0);
        }
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

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
export function begin_run() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.begin_run(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        if (r1) {
            throw takeObject(r0);
        }
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * フォトモザイクの実行をキャンセルする(詳細設計書 7.5)。
 *
 * キャンセルはバッチ境界で効く: 実行中の行バッチは完走したうえで停止する。
 * 既存のマッチ結果と現時点までの合成結果は保持され(exportImage の対象)、
 * 以降の `step_run` はエラーになる(呼び出し側はループを停止する)
 */
export function cancel() {
    wasm.cancel();
}

/**
 * メイン画像の状態を破棄する(リセット操作に対応。大容量バッファを開放する)
 */
export function clear_main_image() {
    wasm.clear_main_image();
}

/**
 * タイルプールを空にする(リセット操作に対応。合成用サムネイルを解放する)
 */
export function clear_tiles() {
    wasm.clear_tiles();
}

/**
 * 現時点の完成画像(または解析対象のメイン画像)RGBA を返す(P5 のエンコード前段)。
 * run 済みの場合は P4 合成結果を、未実行の場合は正規化後のメイン画像を返す
 * (詳細設計書 2 章 exportImage: 「完成画像(または現時点までの合成結果)」)。
 * @returns {Uint8Array}
 */
export function export_main_image() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.export_main_image(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        if (r3) {
            throw takeObject(r2);
        }
        var v1 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export4(r0, r1 * 1, 1);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * プレビュー描画用のブロック平均色を返す。
 *
 * 各ブロックの mean_lab(CIELAB)を sRGB 8bit へ逆変換し、
 * RGB 3 バイト × ブロック数(行優先)のバイト列として返す。
 * メイン画像未設定時は空の配列を返す(論理 API の契約)。
 * @returns {Uint8Array}
 */
export function get_block_mean_colors() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.get_block_mean_colors(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        if (r3) {
            throw takeObject(r2);
        }
        var v1 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export4(r0, r1 * 1, 1);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * 現在の設定(詳細設計書 5 章)を JSON 文字列で返す(詳細設計書 2 章 getConfig)
 * @returns {string}
 */
export function get_config() {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.get_config(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        var ptr1 = r0;
        var len1 = r1;
        if (r3) {
            ptr1 = 0; len1 = 0;
            throw takeObject(r2);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export4(deferred2_0, deferred2_1, 1);
    }
}

/**
 * 登録済みタイル数(進捗の分母・UI の枚数表示に使用)
 * @returns {number}
 */
export function get_tile_count() {
    const ret = wasm.get_tile_count();
    return ret >>> 0;
}

/**
 * 合成用サムネイルの合計バイト数(メモリガードの監視値。wasm32 では 4 GB 未満)
 * @returns {number}
 */
export function get_tiles_memory_bytes() {
    const ret = wasm.get_tiles_memory_bytes();
    return ret >>> 0;
}

/**
 * コアバージョン(Web と Android で同一の .wasm を使うための整合確認用)
 * @returns {string}
 */
export function get_version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.get_version(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
    }
}

/**
 * プールからタイルを削除する。
 *
 * 削除タイルが割当られていたブロックは未確定(None)に戻り、
 * 次の差分再マッチ([`begin_rematch`])で現プールから再割当てされる
 * (詳細設計書 4.4 差分再マッチ: タイル削除時)
 * @param {bigint} id
 */
export function remove_tile(id) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.remove_tile(retptr, id);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        if (r1) {
            throw takeObject(r0);
        }
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * フォトモザイクのマッチング(P3)+ 合成(P4)を一括実行する(同期 API)。
 *
 * 内部では [`begin_run`] + [`step_run`](`None` 時刻)の行バッチ実行を
 * 完走させ、一括実行経路とバッチ実行経路が同一の結果になることを
 * 保証する。進捗イベント・部分結果の通知(M5 の主経路)が必要な場合は
 * begin/step/cancel のペアを使用する
 */
export function run() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.run(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        if (r1) {
            throw takeObject(r0);
        }
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * P1 再実行: ブロックサイズを変更してグリッド・ブロック特徴量を再計算する
 *
 * 基本設計書 3.3: グリッド再計算 → 全ブロック再マッチ → 再合成。
 * タイル特徴量はブロックサイズに依存しないため P2 は再実行しない(キャッシュ再利用)。
 * 割当表は全ブロック未確定に戻る(次の run で全ブロック再マッチになる)
 * @param {number} px
 * @returns {JsGridInfo}
 */
export function set_block_size(px) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.set_block_size(retptr, px);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        if (r2) {
            throw takeObject(r1);
        }
        return JsGridInfo.__wrap(r0);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * 設定 JSON でパラメータを上書きする(詳細設計書 2 章 setConfig)。
 * すべてのフィールドが必須。詳細設計書 5 章の範囲外はエラーになる
 * @param {string} json
 */
export function set_config(json) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        wasm.set_config(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        if (r1) {
            throw takeObject(r0);
        }
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * P1 メイン画像解析: グリッド計算とブロック特徴量を計算し、コア内に保持する。
 *
 * `rgba` は R→G→B→A 順・行優先・非プリマルチプライ・sRGB の 1 ピクセル 4 バイト。
 * ブロックサイズはコア既定値(24px)で計算し、変更は [`set_block_size`] で行う。
 * @param {Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @returns {JsGridInfo}
 */
export function set_main_image(rgba, width, height) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(rgba, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.set_main_image(retptr, ptr0, len0, width, height);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        if (r2) {
            throw takeObject(r1);
        }
        return JsGridInfo.__wrap(r0);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

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
 * @param {number | null} [now_ms]
 * @returns {JsStepOutput}
 */
export function step_run(now_ms) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.step_run(retptr, !isLikeNone(now_ms), isLikeNone(now_ms) ? 0 : now_ms);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        if (r2) {
            throw takeObject(r1);
        }
        return JsStepOutput.__wrap(r0);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_number_get_2e0e7dee9f701a71: function(arg0, arg1) {
            const obj = getObject(arg1);
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_0380ccaa2f57f0d9: function(arg0, arg1) {
            const obj = getObject(arg1);
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_get_31af05bd4842a84f: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(getObject(arg0), getObject(arg1));
            return addHeapObject(ret);
        }, arguments); },
        __wbg_new_343a093a3c2ffb4e: function(arg0, arg1) {
            const ret = new Error(getStringFromWasm0(arg0, arg1));
            return addHeapObject(ret);
        },
        __wbg_new_617a8cdb8bb1130e: function() {
            const ret = new Object();
            return addHeapObject(ret);
        },
        __wbg_parse_0fc53dead14b3b42: function() { return handleError(function (arg0, arg1) {
            const ret = JSON.parse(getStringFromWasm0(arg0, arg1));
            return addHeapObject(ret);
        }, arguments); },
        __wbg_set_145a351398b48c65: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(getObject(arg0), getObject(arg1), getObject(arg2));
            return ret;
        }, arguments); },
        __wbg_stringify_52ff602c1cc4fbb6: function() { return handleError(function (arg0) {
            const ret = JSON.stringify(getObject(arg0));
            return addHeapObject(ret);
        }, arguments); },
        __wbindgen_generic_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return addHeapObject(ret);
        },
        __wbindgen_generic_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return addHeapObject(ret);
        },
        __wbindgen_object_drop_ref: function(arg0) {
            takeObject(arg0);
        },
    };
    return {
        __proto__: null,
        "./photomosaic_core_wasm_bg.js": import0,
    };
}

const JsGridInfoFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jsgridinfo_free(ptr, 1));
const JsProgressEventFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jsprogressevent_free(ptr, 1));
const JsResultBatchFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jsresultbatch_free(ptr, 1));
const JsStepOutputFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jsstepoutput_free(ptr, 1));
const JsTileInfoFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jstileinfo_free(ptr, 1));

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function dropObject(idx) {
    if (idx < 1028) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getObject(idx) { return heap[idx]; }

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        wasm.__wbindgen_export3(addHeapObject(e));
    }
}

let heap = new Array(1024).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('photomosaic_core_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
