/**
 * AndroidX JavaScriptEngine サンドボックス用ホストスクリプト(A2)。
 *
 * DOM に依存しない。グルー(photomosaic_core_wasm.js)より先に評価する。
 * isolate には TextDecoder / TextEncoder が無いため、wasm-bindgen グルーが
 * 文字列を扱えるよう最小限の UTF-8 実装をここで補う。
 *
 * 通信プロトコル(handoff/06 §3.3):
 *   Kotlin → JS: MessagePort の文字列 JSON(制御メッセージ)。RGBA は named data。
 *   JS → Kotlin: 進捗・部分結果・完成画像。JSON の後に ArrayBuffer を続けて送る。
 */

// --- UTF-8 ポリフィル(wasm-bindgen グルーが要求する) ---
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = function (encoding, options) {
    this.encoding = encoding;
    this.fatal = !!(options && options.fatal);
    this.ignoreBOM = !!(options && options.ignoreBOM);

    this.decode = function (buffer) {
      const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      let out = '';
      let i = 0;
      while (i < bytes.length) {
        const b0 = bytes[i++];
        let cp;
        if (b0 < 0x80) {
          cp = b0;
        } else if ((b0 & 0xe0) === 0xc0) {
          cp = ((b0 & 0x1f) << 6) | (bytes[i++] & 0x3f);
        } else if ((b0 & 0xf0) === 0xe0) {
          cp = ((b0 & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
        } else if ((b0 & 0xf8) === 0xf0) {
          cp =
            ((b0 & 0x07) << 18) |
            ((bytes[i++] & 0x3f) << 12) |
            ((bytes[i++] & 0x3f) << 6) |
            (bytes[i++] & 0x3f);
        } else {
          if (this.fatal) {
            throw new TypeError('invalid UTF-8 sequence');
          }
          cp = 0xfffd;
        }
        if (cp > 0xffff) {
          cp -= 0x10000;
          out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        } else {
          out += String.fromCharCode(cp);
        }
      }
      return out;
    };
  };
}

if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = function () {
    this.encode = function (str) {
      const bytes = [];
      for (let i = 0; i < str.length; i += 1) {
        let cp = str.charCodeAt(i);
        if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
          const next = str.charCodeAt(i + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
            i += 1;
          }
        }
        if (cp < 0x80) {
          bytes.push(cp);
        } else if (cp < 0x800) {
          bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
        } else if (cp < 0x10000) {
          bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        } else {
          bytes.push(
            0xf0 | (cp >> 18),
            0x80 | ((cp >> 12) & 0x3f),
            0x80 | ((cp >> 6) & 0x3f),
            0x80 | (cp & 0x3f)
          );
        }
      }
      return new Uint8Array(bytes);
    };
  };
}

let pmPort = null;
let pmLastGrid = null;

function pmPost(message) {
  pmPort.postMessage(JSON.stringify(message));
}

function pmRespond(id, payload, error) {
  if (typeof id !== 'number') {
    return;
  }
  if (error) {
    pmPost({ type: 'response', id: id, ok: false, error: String(error) });
    return;
  }
  pmPost(Object.assign({ type: 'response', id: id, ok: true }, payload || {}));
}

function pmRespondBinary(id, bytes) {
  if (typeof id !== 'number') {
    return;
  }
  pmPost({
    type: 'response',
    id: id,
    ok: true,
    binary: true,
    length: bytes.length,
  });
  pmPort.postMessage(bytes.buffer);
}

function pmGridToObject(info) {
  const grid = {
    width: info.width,
    height: info.height,
    blockSize: info.block_size,
    cols: info.cols,
    rows: info.rows,
    totalBlocks: info.total_blocks,
  };
  info.free();
  return grid;
}

function pmTileToObject(info) {
  const tile = {
    id: Number(info.id),
    thumbWidth: info.thumb_w,
    thumbHeight: info.thumb_h,
    meanLab: [info.mean_lab[0], info.mean_lab[1], info.mean_lab[2]],
    detail: info.detail,
    usage: info.usage,
  };
  info.free();
  return tile;
}

function pmNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

async function pmConsume(ref) {
  return new Uint8Array(await android.consumeNamedDataAsArrayBuffer(ref));
}

async function pmHandleControl(message) {
  try {
    switch (message.type) {
      case 'setMainImage': {
        const bytes = await pmConsume(message.dataRef);
        const info = wasm_bindgen.set_main_image(
          bytes,
          message.meta.width,
          message.meta.height
        );
        pmLastGrid = pmGridToObject(info);
        pmRespond(message.id, { grid: pmLastGrid });
        break;
      }
      case 'setBlockSize': {
        const info = wasm_bindgen.set_block_size(message.px);
        pmLastGrid = pmGridToObject(info);
        pmRespond(message.id, { grid: pmLastGrid });
        break;
      }
      case 'getBlockMeanColors': {
        pmRespondBinary(message.id, wasm_bindgen.get_block_mean_colors());
        break;
      }
      case 'addTile': {
        const feature = await pmConsume(message.featureRef);
        const compose = await pmConsume(message.composeRef);
        const info = wasm_bindgen.add_tile(
          BigInt(message.tileId),
          feature,
          compose,
          message.meta.composeWidth,
          message.meta.composeHeight
        );
        pmRespond(message.id, { tile: pmTileToObject(info) });
        break;
      }
      case 'removeTile': {
        wasm_bindgen.remove_tile(BigInt(message.tileId));
        pmRespond(message.id, {});
        break;
      }
      case 'clearTiles': {
        wasm_bindgen.clear_tiles();
        pmRespond(message.id, {});
        break;
      }
      case 'clearMainImage': {
        wasm_bindgen.clear_main_image();
        pmLastGrid = null;
        pmRespond(message.id, {});
        break;
      }
      case 'getConfig': {
        pmRespond(message.id, { config: JSON.parse(wasm_bindgen.get_config()) });
        break;
      }
      case 'setConfig': {
        wasm_bindgen.set_config(JSON.stringify(message.config));
        pmRespond(message.id, {});
        break;
      }
      case 'run': {
        await pmDriveRun(() => wasm_bindgen.begin_run());
        break;
      }
      case 'rematch': {
        await pmDriveRun(() => wasm_bindgen.begin_rematch());
        break;
      }
      case 'step': {
        if (pmRunResolve) {
          pmStep();
        }
        break;
      }
      case 'cancel': {
        // コアの cancel は実行状態を破棄し、確定済みの合成結果を保持する
        wasm_bindgen.cancel();
        if (pmRunResolve) {
          pmPost({ type: 'canceled' });
          const resolve = pmRunResolve;
          pmRunResolve = null;
          resolve();
        }
        break;
      }
      default:
        pmRespond(message.id, null, 'unknown control type: ' + message.type);
        break;
    }
  } catch (err) {
    const errorText = String(err && err.message ? err.message : err);
    if (typeof message.id === 'number') {
      pmRespond(message.id, null, errorText);
    } else {
      pmPost({ type: 'error', message: errorText });
    }
  }
}

/**
 * begin で開始した行バッチ駆動ループ。
 * 1 バッチごとに進捗 JSON、部分結果(JSON + ArrayBuffer)を送り、
 * 最後に stepDone を送る。Kotlin 側は stepDone を受けて step を返す。
 * サンドボックスに setTimeout が無いため、バッチ境界は MessagePort の
 * 往復で作り、その間にキャンセル・設定変更を受け付ける。
 */
function pmDriveRun(begin) {
  // 前の実行が残っていれば閉じる(要求の合流)
  if (pmRunResolve) {
    const previous = pmRunResolve;
    pmRunResolve = null;
    previous();
  }
  begin();
  return new Promise((resolve) => {
    pmRunResolve = resolve;
    pmStep();
  });
}

let pmRunResolve = null;

function pmStep() {
  let output;
  try {
    output = wasm_bindgen.step_run(pmNow());
  } catch (err) {
    pmPost({ type: 'error', message: String(err && err.message ? err.message : err) });
    if (pmRunResolve) {
      const resolve = pmRunResolve;
      pmRunResolve = null;
      resolve();
    }
    return;
  }

  const progress = output.progress;
  if (progress) {
    pmPost({
      type: 'progress',
      phase_code: progress.phase_code,
      phase_ratio: progress.phase_ratio,
      overall_ratio: progress.overall_ratio,
      assigned_blocks: progress.assigned_blocks,
      total_blocks: progress.total_blocks,
    });
    progress.free();
  }

  const result = output.result;
  if (result) {
    pmPost({
      type: 'batchDone',
      row_begin: result.row_begin,
      row_end: result.row_end,
      block_size: result.block_size,
      width: result.width,
    });
    pmPort.postMessage(result.rgba.buffer);
    result.free();
  }

  const done = output.done;
  const canceled = output.canceled;
  output.free();
  if (done) {
    if (canceled) {
      pmPost({ type: 'canceled' });
    } else {
      const rgba = wasm_bindgen.export_main_image();
      pmPost({
        type: 'result',
        width: pmLastGrid.width,
        height: pmLastGrid.height,
      });
      pmPort.postMessage(rgba.buffer);
    }
    if (pmRunResolve) {
      const resolve = pmRunResolve;
      pmRunResolve = null;
      resolve();
    }
    return;
  }
  pmPost({ type: 'stepDone' });
}

globalThis.__pmCoreReady = false;

/**
 * コアを初期化し、MessagePort の受信ハンドラを設定してバージョンを返す。
 * @param {string} wasmRef provideNamedData で渡した .wasm の参照名
 * @returns {Promise<string>} getVersion() の戻り値
 */
globalThis.__pmInit = async function (wasmRef) {
  if (typeof WebAssembly === 'undefined') {
    throw new Error('WebAssembly is not available');
  }
  pmPort = await android.getNamedPort('core');
  pmPort.onmessage = (event) => {
    if (typeof event.data === 'string') {
      pmHandleControl(JSON.parse(event.data));
    }
  };

  const bytes = await android.consumeNamedDataAsArrayBuffer(wasmRef);
  const module = await WebAssembly.compile(bytes);
  wasm_bindgen.initSync({ module: module });
  globalThis.__pmCoreReady = true;
  return wasm_bindgen.get_version();
};
