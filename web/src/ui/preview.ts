/**
 * Canvas 描画(プレビュー)。
 * 基本設計書 2.2: ブロックサイズ変更直後はグリッド線 + 平均色で表示する。
 *
 * 平均色はコア(P1)が算出した特徴量(mean_lab)を sRGB へ逆変換したもので、
 * bridge 経由で受け取る。UI 層はコア算出値を描画するだけで計算を担わない。
 */
import type { GridInfo, ResultBatch, RgbaImage } from '../core/types';

/** グリッド線の色(dark/light 両方で視認できる中間トーン) */
const GRID_LINE_COLOR = 'rgba(255, 255, 255, 0.6)';

export class Preview {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('failed to acquire 2D context');
    }
    this.ctx = ctx;
  }

  /**
   * グリッド線 + コア算出のブロック平均色を描画する。
   *
   * `meanColors` は bridge.getBlockMeanColors() の戻り値
   * (RGB 3 バイト × ブロック数、行優先)。
   */
  drawGrid(grid: GridInfo, meanColors: Uint8Array): void {
    this.canvas.width = grid.width;
    this.canvas.height = grid.height;
    this.ctx.imageSmoothingEnabled = false;

    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const x = col * grid.blockSize;
        const y = row * grid.blockSize;
        // 半端ブロックは画像端でクリップされる
        const w = Math.min(grid.blockSize, grid.width - x);
        const h = Math.min(grid.blockSize, grid.height - y);
        const offset = ((row * grid.cols + col) as number) * 3;
        const r = meanColors[offset] ?? 0;
        const g = meanColors[offset + 1] ?? 0;
        const b = meanColors[offset + 2] ?? 0;
        this.ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        this.ctx.fillRect(x, y, w, h);
      }
    }

    // グリッド線
    this.ctx.strokeStyle = GRID_LINE_COLOR;
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    for (let col = 1; col < grid.cols; col++) {
      const px = col * grid.blockSize + 0.5;
      this.ctx.moveTo(px, 0);
      this.ctx.lineTo(px, grid.height);
    }
    for (let row = 1; row < grid.rows; row++) {
      const py = row * grid.blockSize + 0.5;
      this.ctx.moveTo(0, py);
      this.ctx.lineTo(grid.width, py);
    }
    this.ctx.stroke();
  }

  /**
   * 完成したフォトモザイク(コアの P4 合成結果)を描画する。
   * `image` は bridge.exportImage() の戻り値(RGBA)。
   */
  drawCompleted(image: RgbaImage): void {
    this.canvas.width = image.width;
    this.canvas.height = image.height;
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  }

  /**
   * 行バッチの部分結果をプレビューに転写する(M5: 詳細設計書 7.4)。
   *
   * キャンバスは生成開始時にグリッド表示で所定サイズに設定済みであること。
   * 受信した行範囲(画素行起点 = blockRowBegin * blockSize)のみを
   * putImageData で上書きし、他の領域(未合成行のグリッド表示)は保持する。
   *
   * `batch` は bridge の onResult ハンドラへ届く値。
   */
  drawResultBatch(batch: ResultBatch): void {
    const pixelBegin = batch.blockRowBegin * batch.blockSize;
    const pixelEnd = Math.min(batch.blockRowEnd * batch.blockSize, this.canvas.height);
    const height = pixelEnd - pixelBegin;
    if (height <= 0 || batch.width !== this.canvas.width) {
      return;
    }
    // putImageData 用に Uint8ClampedArray へ複製する(生成物のバッファ寿命を分離)
    const data = new Uint8ClampedArray(batch.width * height * 4);
    data.set(batch.rgba.subarray(0, data.length));
    this.ctx.putImageData(new ImageData(data, batch.width, height), 0, pixelBegin);
  }
}
