/**
 * 構成画像(タイル)の一覧表示 + 個別削除。
 * 基本設計書 2.2: サムネイルグリッド + 個別削除(最大 3,000 枚程度を想定)。
 *
 * - 追加された順に先頭へ挿入する(直近の追加が上に見える)
 * - サムネイルは装飾的な表示であり、操作は削除ボタンが担うため
 *   画像の alt は空、削除ボタンに文言化された aria-label を付与する
 * - M3 では <img> 一覧で 300 枚規模を許容し、仮想スクロールは必要になった時点で検討する
 */

export class TileList {
  private readonly list: HTMLUListElement;
  private readonly onRemove: (id: bigint) => void;
  private readonly removeLabelFor: (id: bigint) => string;
  private readonly items = new Map<bigint, HTMLLIElement>();

  constructor(
    container: HTMLElement,
    options: {
      onRemove: (id: bigint) => void;
      /** 削除ボタンの aria-label(文言は i18n リソース側で生成する) */
      removeLabelFor: (id: bigint) => string;
    },
  ) {
    this.onRemove = options.onRemove;
    this.removeLabelFor = options.removeLabelFor;
    this.list = document.createElement('ul');
    this.list.className = 'tile-list';
    this.list.setAttribute('role', 'list');
    container.replaceChildren(this.list);
  }

  /** 一覧を別のコンテナへ移動する(S1 / S2 の画面切替で表示位置を変える) */
  attachTo(container: HTMLElement): void {
    container.replaceChildren(this.list);
  }

  /** サムネイルを先頭へ追加する */
  addTile(id: bigint, thumbUrl: string): void {
    if (this.items.has(id)) {
      return;
    }
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
    this.list.prepend(item);
    this.items.set(id, item);
  }

  /** 指定 ID のサムネイルを一覧から取り除く(存在しない id は無視) */
  removeTile(id: bigint): void {
    const item = this.items.get(id);
    if (!item) {
      return;
    }
    item.remove();
    this.items.delete(id);
  }

  /** 一覧を空にする(リセット。サムネイル URL の解放は呼び出し側が行う) */
  clear(): void {
    this.list.replaceChildren();
    this.items.clear();
  }

  /** 表示中の枚数 */
  get count(): number {
    return this.items.size;
  }
}
