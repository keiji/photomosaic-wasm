/**
 * 操作部品(ブロックサイズスライダー・戻る・保存)。
 * 詳細設計書 5 章: ブロックサイズ 8〜128 px。ドラッグ中は再生成せず、
 * スライダー確定時(change)に発火する。
 *
 * S2 からの「戻る」はリセット(全状態クリア → S1 へ)を兼ねる(基本設計書 2.2)。
 */

/** ブロックサイズの範囲(詳細設計書 5 章) */
export const BLOCK_SIZE_MIN = 8;
export const BLOCK_SIZE_MAX = 128;

/** メイン画像ブレンドの範囲・刻み(詳細設計書 5 章 main_blend。右側に現在値表示) */
export const MAIN_BLEND_MIN = 0;
export const MAIN_BLEND_MAX = 0.8;
export const MAIN_BLEND_STEP = 0.05;

/** 色補正強度の範囲・刻み(M8・詳細設計書 5 章 color_correct。右側に現在値表示) */
export const COLOR_CORRECT_MIN = 0;
export const COLOR_CORRECT_MAX = 1;
export const COLOR_CORRECT_STEP = 0.05;
export const COLOR_CORRECT_DEFAULT = 0.85;

/** 重複制御(同一視距離)の範囲・刻み(M8・詳細設計書 5 章 duplicate_de。右側に現在値表示) */
export const DUPLICATE_DE_MIN = 0.5;
export const DUPLICATE_DE_MAX = 8;
export const DUPLICATE_DE_STEP = 0.5;
export const DUPLICATE_DE_DEFAULT = 2;

/** 似た特徴量のタイルを再利用しない(既定 ON) */
export const NO_REUSE_DEFAULT = true;

/** 保存形式(M8・詳細設計書 4.7: 既定 PNG。JPEG 品質は 92) */
export type SaveFormat = 'png' | 'jpeg';
export const SAVE_FORMAT_DEFAULT: SaveFormat = 'png';

export class Controls {
  private readonly root: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly output: HTMLOutputElement;
  private readonly mainBlendSlider: HTMLInputElement;
  private readonly mainBlendOutput: HTMLOutputElement;
  private readonly colorCorrectSlider: HTMLInputElement;
  private readonly colorCorrectOutput: HTMLOutputElement;
  private readonly duplicateDeSlider: HTMLInputElement;
  private readonly duplicateDeOutput: HTMLOutputElement;
  private readonly noReuseCheckbox: HTMLInputElement;
  private readonly saveFormat: HTMLSelectElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly backButton: HTMLButtonElement;
  private readonly generateButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;

  private onBlockSizeChange: (px: number) => void = () => {};
  private onMainBlendChange: (value: number) => void = () => {};
  private onColorCorrectChange: (value: number) => void = () => {};
  private onDuplicateDeChange: (value: number) => void = () => {};
  private onNoReuseChange: (enabled: boolean) => void = () => {};

  constructor(root: HTMLElement) {
    this.root = root;
    this.slider = this.require<HTMLInputElement>('#block-size-slider');
    this.output = this.require<HTMLOutputElement>('#block-size-value');
    this.mainBlendSlider = this.require<HTMLInputElement>('#main-blend-slider');
    this.mainBlendOutput = this.require<HTMLOutputElement>('#main-blend-value');
    this.colorCorrectSlider = this.require<HTMLInputElement>('#color-correct-slider');
    this.colorCorrectOutput = this.require<HTMLOutputElement>('#color-correct-value');
    this.duplicateDeSlider = this.require<HTMLInputElement>('#duplicate-de-slider');
    this.duplicateDeOutput = this.require<HTMLOutputElement>('#duplicate-de-value');
    this.noReuseCheckbox = this.require<HTMLInputElement>('#no-reuse-checkbox');
    this.saveFormat = this.require<HTMLSelectElement>('#save-format');
    this.saveButton = this.require<HTMLButtonElement>('#save-button');
    this.backButton = this.require<HTMLButtonElement>('#back-button');
    this.generateButton = this.require<HTMLButtonElement>('#generate-button');
    this.cancelButton = this.require<HTMLButtonElement>('#cancel-button');

    this.output.textContent = this.formatSize(Number(this.slider.value));
    this.updateMainBlendOutput();
    this.updateColorCorrectOutput();
    this.updateDuplicateDeOutput();

    // ブロックサイズ: ドラッグ中(input)は表示だけ更新し、確定(change)時に再生成する
    this.slider.addEventListener('input', () => {
      this.output.textContent = this.formatSize(Number(this.slider.value));
    });
    this.slider.addEventListener('change', () => {
      this.onBlockSizeChange(Number(this.slider.value));
    });

    // メイン画像ブレンド: ドラッグ中(input)は表示だけ更新し、確定(change)時に再生成する
    this.mainBlendSlider.addEventListener('input', () => {
      this.updateMainBlendOutput();
    });
    this.mainBlendSlider.addEventListener('change', () => {
      this.updateMainBlendOutput();
      this.onMainBlendChange(Number(this.mainBlendSlider.value));
    });

    // 色補正強度(M8): メイン画像ブレンドと同じく確定時に再生成する
    this.colorCorrectSlider.addEventListener('input', () => {
      this.updateColorCorrectOutput();
    });
    this.colorCorrectSlider.addEventListener('change', () => {
      this.updateColorCorrectOutput();
      this.onColorCorrectChange(Number(this.colorCorrectSlider.value));
    });

    // 重複制御(M8): 同一視グループの再構築を伴うため、確定時に再マッチ込みで再生成する
    this.duplicateDeSlider.addEventListener('input', () => {
      this.updateDuplicateDeOutput();
    });
    this.duplicateDeSlider.addEventListener('change', () => {
      this.updateDuplicateDeOutput();
      this.onDuplicateDeChange(Number(this.duplicateDeSlider.value));
    });

    // 再利用禁止: マッチング規則の変更なので、確定時にフル再生成する
    this.noReuseCheckbox.addEventListener('change', () => {
      this.onNoReuseChange(this.noReuseCheckbox.checked);
    });
  }

  /** ブロックサイズの表示値を設定する(イベント発火なし) */
  setBlockSizeValue(px: number): void {
    this.slider.value = String(px);
    this.output.textContent = this.formatSize(px);
  }

  /** ブロックサイズ変更のコールバックを登録する(スライダー確定時に呼ばれる) */
  handleBlockSizeChange(handler: (px: number) => void): void {
    this.onBlockSizeChange = handler;
  }

  /** メイン画像ブレンドの表示値を設定する(イベント発火なし。リセット用) */
  setMainBlendValue(value: number): void {
    this.mainBlendSlider.value = String(value);
    this.updateMainBlendOutput();
  }

  /** メイン画像ブレンド確定(マウスを離した)のコールバックを登録する */
  handleMainBlendChange(handler: (value: number) => void): void {
    this.onMainBlendChange = handler;
  }

  /** 色補正強度(M8)の表示値を設定する(イベント発火なし。リセット用) */
  setColorCorrectValue(value: number): void {
    this.colorCorrectSlider.value = String(value);
    this.updateColorCorrectOutput();
  }

  /** 色補正強度確定(マウスを離した)のコールバックを登録する(M8) */
  handleColorCorrectChange(handler: (value: number) => void): void {
    this.onColorCorrectChange = handler;
  }

  /** 重複制御(M8)の表示値を設定する(イベント発火なし。リセット用) */
  setDuplicateDeValue(value: number): void {
    this.duplicateDeSlider.value = String(value);
    this.updateDuplicateDeOutput();
  }

  /** 重複制御確定(マウスを離した)のコールバックを登録する(M8) */
  handleDuplicateDeChange(handler: (value: number) => void): void {
    this.onDuplicateDeChange = handler;
  }

  /** 再利用禁止の表示値を設定する(イベント発火なし。リセット用) */
  setNoReuseValue(enabled: boolean): void {
    this.noReuseCheckbox.checked = enabled;
  }

  /** 再利用禁止の切り替えコールバックを登録する */
  handleNoReuseChange(handler: (enabled: boolean) => void): void {
    this.onNoReuseChange = handler;
  }

  /** 選択中の保存形式を返す(M8・保存時に参照する) */
  getSaveFormat(): SaveFormat {
    return this.saveFormat.value === 'jpeg' ? 'jpeg' : 'png';
  }

  /** 保存形式の表示を設定する(イベント発火なし。リセット用) */
  setSaveFormat(format: SaveFormat): void {
    this.saveFormat.value = format;
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

  private updateMainBlendOutput(): void {
    this.mainBlendOutput.textContent = this.formatDecimal(Number(this.mainBlendSlider.value), 2);
  }

  private updateColorCorrectOutput(): void {
    this.colorCorrectOutput.textContent = this.formatDecimal(
      Number(this.colorCorrectSlider.value),
      2,
    );
  }

  private updateDuplicateDeOutput(): void {
    this.duplicateDeOutput.textContent = this.formatDecimal(
      Number(this.duplicateDeSlider.value),
      1,
    );
  }

  private formatSize(px: number): string {
    return `${px} px`;
  }

  private formatDecimal(value: number, digits: number): string {
    return value.toFixed(digits);
  }

  private require<T extends HTMLElement>(selector: string): T {
    const el = this.root.querySelector<T>(selector);
    if (!el) {
      throw new Error(`controls element not found: ${selector}`);
    }
    return el;
  }
}
