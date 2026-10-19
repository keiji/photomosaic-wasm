/**
 * 操作部品(ブロックサイズスライダー・戻る・保存)。
 * 詳細設計書 5 章: ブロックサイズ 8〜128 px、スライダー操作中は 300ms デバウンス後に発火。
 *
 * S2 からの「戻る」はリセット(全状態クリア → S1 へ)を兼ねる(基本設計書 2.2)。
 */

/** スライダー操作のデバウンス時間 ms(詳細設計書 5 章 block_size) */
export const BLOCK_SIZE_DEBOUNCE_MS = 300;

/** ブロックサイズの範囲(詳細設計書 5 章) */
export const BLOCK_SIZE_MIN = 8;
export const BLOCK_SIZE_MAX = 128;

/** メイン画像ブレンドの範囲・刻み(詳細設計書 5 章 main_blend。数値表示なし) */
export const MAIN_BLEND_MIN = 0;
export const MAIN_BLEND_MAX = 0.8;
export const MAIN_BLEND_STEP = 0.05;

export class Controls {
  private readonly root: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly output: HTMLOutputElement;
  private readonly mainBlendSlider: HTMLInputElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly backButton: HTMLButtonElement;
  private readonly generateButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private onBlockSizeChange: (px: number) => void = () => {};
  private onMainBlendChange: (value: number) => void = () => {};
  private pendingValue: number | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.slider = this.require<HTMLInputElement>('#block-size-slider');
    this.output = this.require<HTMLOutputElement>('#block-size-value');
    this.mainBlendSlider = this.require<HTMLInputElement>('#main-blend-slider');
    this.saveButton = this.require<HTMLButtonElement>('#save-button');
    this.backButton = this.require<HTMLButtonElement>('#back-button');
    this.generateButton = this.require<HTMLButtonElement>('#generate-button');
    this.cancelButton = this.require<HTMLButtonElement>('#cancel-button');

    this.output.textContent = this.formatSize(Number(this.slider.value));

    this.slider.addEventListener('input', () => {
      const px = Number(this.slider.value);
      this.output.textContent = this.formatSize(px);
      this.scheduleDebounce(px);
    });

    // メイン画像ブレンド: ドラッグ中(input)は再計算せず、確定(マウスを
    // 離した = change)したタイミングでのみ再計算を依頼する
    this.mainBlendSlider.addEventListener('change', () => {
      this.onMainBlendChange(Number(this.mainBlendSlider.value));
    });
  }

  /** ブロックサイズの表示値を設定する(イベント発火なし) */
  setBlockSizeValue(px: number): void {
    this.slider.value = String(px);
    this.output.textContent = this.formatSize(px);
  }

  /** ブロックサイズ変更のコールバックを登録する(デバウンス後に呼ばれる) */
  handleBlockSizeChange(handler: (px: number) => void): void {
    this.onBlockSizeChange = handler;
  }

  /** メイン画像ブレンドの表示値を設定する(イベント発火なし。リセット用) */
  setMainBlendValue(value: number): void {
    this.mainBlendSlider.value = String(value);
  }

  /** メイン画像ブレンド確定(マウスを離した)のコールバックを登録する */
  handleMainBlendChange(handler: (value: number) => void): void {
    this.onMainBlendChange = handler;
  }

  /** 保存・戻るの各操作を登録する(戻るがリセットを兼ねる) */
  handleSave(handler: () => void): void {
    this.saveButton.addEventListener('click', handler);
  }

  handleBack(handler: () => void): void {
    this.backButton.addEventListener('click', handler);
  }

  /** フォトモザイク一括生成(M4)の実行ハンドラを登録する */
  handleGenerate(handler: () => void): void {
    this.generateButton.addEventListener('click', handler);
  }

  /** 生成のキャンセル(M5)の実行ハンドラを登録する */
  handleCancel(handler: () => void): void {
    this.cancelButton.addEventListener('click', handler);
  }

  /** キャンセルボタンの表示/非隠蔽を切り替える(GENERATING 中のみ表示) */
  setCancelVisible(visible: boolean): void {
    this.cancelButton.hidden = !visible;
  }

  /** 生成ボタンの有効/無効を切り替える */
  setGenerateEnabled(enabled: boolean): void {
    this.generateButton.disabled = !enabled;
  }

  /** 保存ボタンの有効/無効を切り替える(基本設計書 1.4: DONE で有効) */
  setSaveEnabled(enabled: boolean): void {
    this.saveButton.disabled = !enabled;
  }

  /** デバウンス済みの変更要求を確定させる(テスト補助用) */
  flushDebounce(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pendingValue !== null) {
      const value = this.pendingValue;
      this.pendingValue = null;
      this.onBlockSizeChange(value);
    }
  }

  private formatSize(px: number): string {
    return `${px} px`;
  }

  private scheduleDebounce(px: number): void {
    this.pendingValue = px;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const value = this.pendingValue;
      this.pendingValue = null;
      if (value !== null) {
        this.onBlockSizeChange(value);
      }
    }, BLOCK_SIZE_DEBOUNCE_MS);
  }

  private require<T extends HTMLElement>(selector: string): T {
    const el = this.root.querySelector<T>(selector);
    if (!el) {
      throw new Error(`controls element not found: ${selector}`);
    }
    return el;
  }
}
