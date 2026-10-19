/**
 * 構成画像(タイル)の一覧表示 + 個別削除。
 * 基本設計書 2.2: サムネイルグリッド + 個別削除(最大 3,000 枚程度を想定)。
 *
 * - 追加された順に先頭へ挿入する(直近の追加が上に見える)
 * - 表示は折りたたみ中 [`TILE_PREVIEW_LIMIT`] 枚まで(最初に読み込んだ分)。
 *   21 枚目以降は保留し、「すべての画像を表示」でまとめて挿入する。展開後の
 *   追加は直接表示する。削除で表示枠が空いたときは保留の最古 1 枚を繰り上げる
 *   (常に最初に読み込んだ TILE_PREVIEW_LIMIT 枚が見える)
 * - 読み込み進捗(setLoadingProgress)は一覧ラッパー内に表示し、S1 / S2 の
 *   どちらの画面でも一覧と一緒に移動して見える
 * - サムネイルは装飾的な表示であり、操作は削除ボタンが担うため
 *   画像の alt は空、削除ボタンに文言化された aria-label を付与する
 */

/** 折りたたみ中の表示枚数上限(基本設計書 2.2: 初期は 20 枚程度を限度に表示) */
export const TILE_PREVIEW_LIMIT = 20;

export class TileList {
  private readonly wrap: HTMLDivElement;
  private readonly list: HTMLUListElement;
  private readonly loading: HTMLParagraphElement;
  private readonly showAll: HTMLButtonElement;
  private readonly onRemove: (id: bigint) => void;
  private readonly removeLabelFor: (id: bigint) => string;
  private readonly showAllLabelFor: (hidden: number) => string;
  private readonly loadingLabelFor: (done: number, total: number) => string;
  private readonly items = new Map<bigint, HTMLLIElement>();
  /** 折りたたみ中に表示を保留している項目(挿入順 = 読み込み順) */
  private pending: HTMLLIElement[] = [];
  /** 「すべての画像を表示」で展開済みか(展開後は以降の追加も直接表示する) */
  private expanded = false;

  constructor(
    container: HTMLElement,
    options: {
      onRemove: (id: bigint) => void;
      /** 削除ボタンの aria-label(文言は i18n リソース側で生成する) */
      removeLabelFor: (id: bigint) => string;
      /** 「すべての画像を表示」ボタンの文言(非表示枚数を引数に取る) */
      showAllLabelFor: (hidden: number) => string;
      /** 読み込み進捗の文言(処理済み枚数と総数) */
      loadingLabelFor: (done: number, total: number) => string;
    },
  ) {
    this.onRemove = options.onRemove;
    this.removeLabelFor = options.removeLabelFor;
    this.showAllLabelFor = options.showAllLabelFor;
    this.loadingLabelFor = options.loadingLabelFor;

    this.loading = document.createElement('p');
    this.loading.className = 'tile-loading';
    this.loading.hidden = true;

    this.list = document.createElement('ul');
    this.list.className = 'tile-list';
    this.list.setAttribute('role', 'list');

    this.showAll = document.createElement('button');
    this.showAll.type = 'button';
    this.showAll.className = 'tile-show-all button';
    this.showAll.hidden = true;
    this.showAll.addEventListener('click', () => {
      this.expand();
    });

    this.wrap = document.createElement('div');
    this.wrap.className = 'tile-list-wrap';
    this.wrap.append(this.loading, this.list, this.showAll);
    container.replaceChildren(this.wrap);
  }

  /** 一覧を別のコンテナへ移動する(S1 / S2 の画面切替で表示位置を変える) */
  attachTo(container: HTMLElement): void {
    // 同一コンテナ内では再挿入しない(フォーカス・遅延読み込みの状態を保つ)
    if (this.wrap.parentElement === container) {
      return;
    }
    container.replaceChildren(this.wrap);
  }

  /** サムネイルを先頭へ追加する(折りたたみ中の上限超は保留する) */
  addTile(id: bigint, thumbUrl: string): void {
    if (this.items.has(id)) {
      return;
    }
    const item = this.createItem(id, thumbUrl);
    this.items.set(id, item);
    if (this.expanded || this.items.size - this.pending.length <= TILE_PREVIEW_LIMIT) {
      this.list.prepend(item);
    } else {
      this.pending.push(item);
    }
    this.updateShowAll();
  }

  /** 指定 ID のサムネイルを一覧から取り除く(存在しない id は無視) */
  removeTile(id: bigint): void {
    const item = this.items.get(id);
    if (!item) {
      return;
    }
    const pendingIndex = this.pending.indexOf(item);
    if (pendingIndex >= 0) {
      this.pending.splice(pendingIndex, 1);
    } else {
      item.remove();
      // 折りたたみ中は保留の最古 1 枚を繰り上げる(最初に読み込んだ
      // TILE_PREVIEW_LIMIT 枚が見え続ける。保留分は表示中のどの項目より
      // 新しいため先頭へ置く)
      if (!this.expanded) {
        const next = this.pending.shift();
        if (next) {
          this.list.prepend(next);
        }
      }
    }
    this.items.delete(id);
    this.updateShowAll();
  }

  /** 読み込み進捗を表示する(処理済み枚数 / 総数。文言は i18n リソース側) */
  setLoadingProgress(done: number, total: number): void {
    this.loading.hidden = false;
    this.loading.textContent = this.loadingLabelFor(done, total);
  }

  /** 読み込み進捗表示を消す(読み込み完了時) */
  hideLoading(): void {
    this.loading.hidden = true;
  }

  /** 一覧を空にする(リセット。サムネイル URL の解放は呼び出し側が行う) */
  clear(): void {
    this.list.replaceChildren();
    this.items.clear();
    this.pending = [];
    this.expanded = false;
    this.showAll.hidden = true;
    this.hideLoading();
  }

  /** 表示中の枚数 */
  get count(): number {
    return this.items.size;
  }

  /** 1 枚分の項目(サムネイル + 削除ボタン)を生成する */
  private createItem(id: bigint, thumbUrl: string): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'tile-item';

    const image = document.createElement('img');
    image.className = 'tile-thumb';
    image.src = thumbUrl;
    image.alt = '';
    image.loading = 'lazy';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'tile-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', this.removeLabelFor(id));
    remove.addEventListener('click', () => {
      this.onRemove(id);
    });

    item.append(image, remove);
    return item;
  }

  /** 「すべての画像を表示」で保留分をまとめて挿入する */
  private expand(): void {
    this.expanded = true;
    // 保留分を挿入順(= 読み込み順)に先頭へ置くと全体が新着順の並びになる
    // (prepend(t21) → prepend(t22) → … で t22 が t21 の上に載る)
    for (const item of this.pending) {
      this.list.prepend(item);
    }
    this.pending = [];
    this.updateShowAll();
  }

  /** 「すべての画像を表示」ボタンの表示・文言を更新する */
  private updateShowAll(): void {
    const hidden = this.pending.length;
    this.showAll.hidden = this.expanded || hidden === 0;
    if (!this.showAll.hidden) {
      this.showAll.textContent = this.showAllLabelFor(hidden);
    }
  }
}
