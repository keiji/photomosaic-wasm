/**
 * Canvas 描画(プレビュー)。
 * 基本設計書 2.2: ブロックサイズ変更直後はグリッド線 + 平均色で表示する。
 *
 * ブロック平均色の本計算(線形 RGB 平均 → CIELAB)はコア(P1)の責務で、
 * M2 で差し替わる。M0 のモック段階では描画に必要な簡易平均(sRGB 平均)を
 * 本モジュール内で計算し、グリッド表示の見栄えを確保する。
 */
import type { GridInfo } from '../core/types';
import type { LoadedImage } from '../io/imageLoader';

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

  /** メイン画像をそのまま表示する(グリッド未確定の初期状態) */
  drawImage(image: LoadedImage): void {
    this.canvas.width = image.width;
    this.canvas.height = image.height;
    this.ctx.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  }

  /**
   * ブロック平均色 + グリッド線を描画する。
   * 平均色は M2 でコア算出の特徴量へ置き換わる(現状は簡易 sRGB 平均)。
   */
  drawGrid(image: LoadedImage, grid: GridInfo): void {
    this.canvas.width = image.width;
    this.canvas.height = image.height;
    this.ctx.imageSmoothingEnabled = false;

    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const x = col * grid.blockSize;
        const y = row * grid.blockSize;
        // 半端ブロックは画像端でクリップされる
        const w = Math.min(grid.blockSize, image.width - x);
        const h = Math.min(grid.blockSize, image.height - y);
        this.ctx.fillStyle = meanColor(image, x, y, w, h);
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
      this.ctx.lineTo(px, image.height);
    }
    for (let row = 1; row < grid.rows; row++) {
      const py = row * grid.blockSize + 0.5;
      this.ctx.moveTo(0, py);
      this.ctx.lineTo(image.width, py);
    }
    this.ctx.stroke();
  }
}

/** 矩形内の sRGB 単純平均を CSS カラーコードとして返す(M0 のモック用簡易実装) */
function meanColor(image: LoadedImage, x: number, y: number, w: number, h: number): string {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let py = y; py < y + h; py++) {
    let offset = (py * image.width + x) * 4;
    for (let px = 0; px < w; px++) {
      r += image.data[offset] as number;
      g += image.data[offset + 1] as number;
      b += image.data[offset + 2] as number;
      offset += 4;
    }
  }
  const count = w * h;
  const to = (sum: number): number => Math.round(sum / count);
  return `rgb(${to(r)}, ${to(g)}, ${to(b)})`;
}
