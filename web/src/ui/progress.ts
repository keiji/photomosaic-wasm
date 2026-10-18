/**
 * 進捗表示領域(基本設計書 2.3)。
 * 2 層構成: フェーズ表示 + 横方向進捗バー(割当済み/全体ブロック数)。
 *
 * 開閉仕様: 既定は表示。非表示中も処理・イベント受信・部分描画は継続し、
 * 切替状態は localStorage に保持する。開閉ボタンには aria-expanded を付与する。
 */
import { messages } from '../i18n/messages';

const STORAGE_KEY = 'photomosaic.progress.visible';

export class ProgressPanel {
  private readonly section: HTMLElement;
  private readonly toggleButton: HTMLButtonElement;
  private readonly body: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly barFill: HTMLElement;
  private readonly barLabel: HTMLElement;
  private readonly phaseLabel: HTMLElement;
  private visible: boolean;

  constructor(root: HTMLElement) {
    this.section = root;
    this.toggleButton = this.require<HTMLButtonElement>('#progress-toggle');
    this.body = this.require<HTMLElement>('#progress-body');
    this.bar = this.require<HTMLElement>('#progress-bar');
    this.barFill = this.require<HTMLElement>('#progress-bar-fill');
    this.barLabel = this.require<HTMLElement>('#progress-label');
    this.phaseLabel = this.require<HTMLElement>('#phase-label');

    const stored = localStorage.getItem(STORAGE_KEY);
    this.visible = stored === null ? true : stored === 'true';

    this.require<HTMLElement>('#progress-title').textContent = messages.progressTitle;
    this.toggleButton.addEventListener('click', () => {
      this.setVisible(!this.visible);
    });

    this.render();
    this.setCounts(0, 0);
    this.setPhase(messages.phaseIdle);
  }

  /** 割当済み/全体ブロック数とバーを更新する */
  setCounts(assigned: number, total: number): void {
    const percent = total > 0 ? Math.floor((assigned / total) * 100) : 0;
    this.barLabel.textContent = messages.progressBlocksLabel(assigned, total, percent);
    this.barFill.style.width = `${percent}%`;
    this.bar.setAttribute('aria-valuenow', String(percent));
  }

  /** フェーズ表示を更新する(コード → 文言化は本クラスで実施) */
  setPhase(label: string): void {
    this.phaseLabel.textContent = label;
  }

  /** 進捗表示をリセットする(メイン画像再設定時など) */
  reset(): void {
    this.setCounts(0, 0);
    this.setPhase(messages.phaseIdle);
  }

  private setVisible(value: boolean): void {
    this.visible = value;
    localStorage.setItem(STORAGE_KEY, String(value));
    this.render();
  }

  private render(): void {
    this.body.hidden = !this.visible;
    this.toggleButton.textContent = this.visible ? messages.progressHide : messages.progressShow;
    this.toggleButton.setAttribute('aria-expanded', String(this.visible));
  }

  private require<T extends HTMLElement>(selector: string): T {
    const el = this.section.querySelector<T>(selector);
    if (!el) {
      throw new Error(`progress panel element not found: ${selector}`);
    }
    return el;
  }
}
