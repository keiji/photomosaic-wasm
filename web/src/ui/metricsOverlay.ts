/**
 * メトリクスオーバーレイ(M7: handoff/05 §6)。
 *
 * - コアの getMetrics() 結果の直近 run のフェーズ所要・バッチ最大所要・
 *   メモリを表示する
 * - 表示内容の右側にコピーアイコンを置き、metrics JSON をクリップボードへコピーする
 * - × ボタンで閉じるまで表示を維持する(次回の計測更新で再表示する)
 */
import { messages } from '../i18n/messages';
import type { MetricsRun } from '../core/types';

const OVERLAY_ID = 'metrics-overlay';

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';

const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="currentColor"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

export class MetricsOverlay {
  private readonly element: HTMLElement | null = null;
  private readonly textElement: HTMLElement | null = null;
  private readonly copyButton: HTMLButtonElement | null = null;
  private lastLine = '';
  private clipboardText = '';

  constructor(document: Document) {
    const element = document.createElement('aside');
    element.id = OVERLAY_ID;
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
      'max-width:min(92vw,720px)',
    ].join(';');

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:flex-start;gap:6px;';

    const text = document.createElement('span');
    text.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;';

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'metrics-copy';
    copyButton.title = messages.metricsCopyLabel;
    copyButton.setAttribute('aria-label', messages.metricsCopyLabel);
    copyButton.disabled = true;
    copyButton.style.cssText =
      'pointer-events:auto;border:0;background:transparent;color:inherit;padding:0;cursor:pointer;';
    copyButton.innerHTML = COPY_ICON;
    copyButton.addEventListener('click', () => {
      void this.copy();
    });

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'metrics-close';
    closeButton.title = messages.metricsCloseLabel;
    closeButton.setAttribute('aria-label', messages.metricsCloseLabel);
    closeButton.style.cssText =
      'pointer-events:auto;border:0;background:transparent;color:inherit;padding:0;cursor:pointer;';
    closeButton.innerHTML = CLOSE_ICON;
    closeButton.addEventListener('click', () => {
      this.dismiss();
    });

    row.append(text, copyButton, closeButton);
    element.append(row);
    element.hidden = true;
    document.body.append(element);
    this.element = element;
    this.textElement = text;
    this.copyButton = copyButton;
  }

  /** run の計測結果を更新する(直近 run の 1 行サマリ)。データが無ければ隠す */
  update(runs: MetricsRun[]): void {
    const element = this.element;
    const textElement = this.textElement;
    if (!element || !textElement) {
      return;
    }
    const run = runs.at(-1);
    if (!run) {
      this.clear();
      return;
    }
    const line = [
      `[metrics #${run.runId}] trigger: ${run.trigger}`,
      `P1 ${run.phases.P1_MAIN_ANALYZE.ms.toFixed(0)}ms | P2 ${run.phases.P2_TILE_ANALYZE.ms.toFixed(0)}ms (${run.phases.P2_TILE_ANALYZE.tiles}) | P3 ${run.phases.P3_MATCH.ms.toFixed(0)}ms (${run.phases.P3_MATCH.batches}) | P4 ${run.phases.P4_COMPOSE.ms.toFixed(0)}ms (${run.phases.P4_COMPOSE.batches})`,
      `batch max: P3 ${fmtMs(run.spans.p3_match_batch?.maxMs)} / P4 ${fmtMs(run.spans.p4_compose_batch?.maxMs)} | tiles ${fmtBytes(run.memory.tilesBytes)}`,
    ].join('\n');
    this.clipboardText = JSON.stringify(runs, null, 2);
    if (line !== this.lastLine) {
      this.lastLine = line;
      textElement.textContent = line;
    }
    if (this.copyButton) {
      this.copyButton.disabled = false;
    }
    element.hidden = false;
  }

  /** リセット時のクリア */
  clear(): void {
    this.lastLine = '';
    this.clipboardText = '';
    if (this.copyButton) {
      this.copyButton.disabled = true;
    }
    if (this.element) {
      this.element.hidden = true;
    }
  }

  /** × ボタンで閉じる。次回の update で新しい計測結果を表示する */
  private dismiss(): void {
    if (this.element) {
      this.element.hidden = true;
    }
  }

  private async copy(): Promise<void> {
    if (this.clipboardText.length === 0) {
      return;
    }
    try {
      await copyText(this.clipboardText);
    } catch (err) {
      console.warn('metrics copy failed', err);
    }
  }
}

/** クリップボードへ書き込む。Clipboard API が使えない場合は textarea で代替する */
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 権限や非セキュアコンテキストではフォールバックへ進む
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.cssText = 'position:fixed;left:-9999px;top:0;';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) {
    throw new Error('clipboard write failed');
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
