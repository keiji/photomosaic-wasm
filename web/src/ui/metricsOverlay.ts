/**
 * 開発ビルド限定のメトリクスオーバーレイ(M7: handoff/05 §6 開発中オーバーレイ)。
 *
 * - import.meta.env.PROD では生成しない(本番には表示されない)
 * - コアの getMetrics() 結果の直近 run のフェーズ所要・バッチ最大所要・
 *   メモリを常時表示する
 */
import type { MetricsRun } from '../core/types';

const OVERLAY_ID = 'metrics-overlay';

export class MetricsOverlay {
  private readonly element: HTMLElement | null = null;
  private lastLine = '';

  constructor(document: Document) {
    if (!import.meta.env.PROD) {
      const element = document.createElement('aside');
      element.id = OVERLAY_ID;
      element.setAttribute('aria-hidden', 'true');
      element.style.cssText = [
        'position:fixed',
        'right:8px',
        'bottom:8px',
        'z-index:2147483647',
        'padding:6px 8px',
        'font:11px/1.5 ui-monospace, monospace',
        'color:#e6e6e6',
        'background:rgba(20,20,20,0.82)',
        'border-radius:6px',
        'pointer-events:none',
        'white-space:pre',
      ].join(';');
      element.hidden = true;
      document.body.append(element);
      this.element = element;
    }
  }

  /** run の計測結果を更新する(直近 run の 1 行サマリ)。データが無ければ隠す */
  update(runs: MetricsRun[]): void {
    const element = this.element;
    if (!element) {
      return; // 本番ビルドでは何もしない
    }
    const run = runs.at(-1);
    if (!run) {
      element.hidden = true;
      return;
    }
    const line = [
      `[metrics #${run.runId}] trigger: ${run.trigger}`,
      `P1 ${run.phases.P1_MAIN_ANALYZE.ms.toFixed(0)}ms | P2 ${run.phases.P2_TILE_ANALYZE.ms.toFixed(0)}ms (${run.phases.P2_TILE_ANALYZE.tiles}) | P3 ${run.phases.P3_MATCH.ms.toFixed(0)}ms (${run.phases.P3_MATCH.batches}) | P4 ${run.phases.P4_COMPOSE.ms.toFixed(0)}ms (${run.phases.P4_COMPOSE.batches})`,
      `batch max: P3 ${fmtMs(run.spans.p3_match_batch?.maxMs)} / P4 ${fmtMs(run.spans.p4_compose_batch?.maxMs)} | tiles ${fmtBytes(run.memory.tilesBytes)}`,
    ].join('\n');
    if (line !== this.lastLine) {
      this.lastLine = line;
      element.textContent = line;
    }
    element.hidden = false;
  }

  /** リセット時のクリア */
  clear(): void {
    this.lastLine = '';
    if (this.element) {
      this.element.hidden = true;
    }
  }
}

/** ミリ秒の簡易整形(スパン未記録は "-") */
function fmtMs(value: number | undefined): string {
  if (value === undefined) {
    return '-';
  }
  return `${value.toFixed(0)}ms`;
}

/** バイト数の簡易整形 */
function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  return `${Math.round(bytes / 1024)}KB`;
}
