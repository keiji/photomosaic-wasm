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

export class Controls {
  private readonly root: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly output: HTMLOutputElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly backButton: HTMLButtonElement;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private onBlockSizeChange: (px: number) => void = () => {};
  private pendingValue: number | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.slider = this.require<HTMLInputElement>('#block-size-slider');
    this.output = this.require<HTMLOutputElement>('#block-size-value');
    this.saveButton = this.require<HTMLButtonElement>('#save-button');
    this.backButton = this.require<HTMLButtonElement>('#back-button');

    this.output.textContent = this.formatSize(Number(this.slider.value));

    this.slider.addEventListener('input', () => {
      const px = Number(this.slider.value);
      this.output.textContent = this.formatSize(px);
      this.scheduleDebounce(px);
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

  /** 保存・戻るの各操作を登録する(戻るがリセットを兼ねる) */
  handleSave(handler: () => void): void {
    this.saveButton.addEventListener('click', handler);
  }

  handleBack(handler: () => void): void {
    this.backButton.addEventListener('click', handler);
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
