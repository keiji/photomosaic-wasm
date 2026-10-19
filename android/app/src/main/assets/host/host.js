/**
 * AndroidX JavaScriptEngine サンドボックス用ホストスクリプト(A0)。
 *
 * DOM に依存しない。グルー(photomosaic_core_wasm.js)より先に評価する。
 * isolate には TextDecoder / TextEncoder が無いため、wasm-bindgen グルーが
 * 文字列を扱えるよう最小限の UTF-8 実装をここで補う。
 * .wasm は Kotlin 側から provideNamedData で渡され、
 * consumeNamedDataAsArrayBuffer で受け取って WebAssembly.compile する。
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

globalThis.__pmCoreReady = false;

/**
 * コアを初期化してバージョン文字列を返す。
 * @param {string} wasmRef provideNamedData で渡した .wasm の参照名
 * @returns {Promise<string>} getVersion() の戻り値
 */
globalThis.__pmInit = async function (wasmRef) {
  if (typeof WebAssembly === 'undefined') {
    throw new Error('WebAssembly is not available');
  }
  const bytes = await android.consumeNamedDataAsArrayBuffer(wasmRef);
  const module = await WebAssembly.compile(bytes);
  wasm_bindgen.initSync({ module: module });
  globalThis.__pmCoreReady = true;
  return wasm_bindgen.get_version();
};
