/**
 * ドラッグ & ドロップ + クリック(ファイル選択)の受付。
 * 基本設計書 5 章: ドロップ領域はタップ入力にフォールバックする
 * (クリックで <input type="file"> を開く)。
 */

export interface FileZoneOptions {
  /** 複数選択を許可するか */
  multiple: boolean;
  /** ファイル確定時に呼ばれるコールバック */
  onFiles: (files: File[]) => void;
}

/**
 * クリック/ドロップ両対応のファイル受付を設定する。
 * 戻り値は後片付け用の関数(M0 ではページ存続中に破棄しないが、単体テスト容易性のため返す)。
 */
export function setupFileZone(zone: HTMLElement, options: FileZoneOptions): () => void {
  const { multiple, onFiles } = options;

  // ゾーン自身が <input type="file"> でない場合のみ、隠し input を用意する
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = multiple;
  input.hidden = true;
  input.addEventListener('change', () => {
    emitFiles(Array.from(input.files ?? []));
    input.value = '';
  });
  zone.insertAdjacentElement('afterend', input);

  const emitFiles = (files: File[]): void => {
    if (files.length === 0) return;
    if (multiple) {
      onFiles(files);
    } else {
      onFiles([files[0] as File]);
    }
  };

  const onClick = (): void => {
    input.click();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  };

  const onDragOver = (event: DragEvent): void => {
    event.preventDefault();
    zone.classList.add('is-dragover');
  };

  const onDragLeave = (): void => {
    zone.classList.remove('is-dragover');
  };

  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    zone.classList.remove('is-dragover');
    const items = event.dataTransfer?.files;
    if (!items) return;
    const files = Array.from(items);
    emitFiles(multiple ? files : files.slice(0, 1));
  };

  zone.addEventListener('click', onClick);
  zone.addEventListener('keydown', onKeyDown);
  zone.addEventListener('dragover', onDragOver);
  zone.addEventListener('dragleave', onDragLeave);
  zone.addEventListener('drop', onDrop);

  return () => {
    zone.removeEventListener('click', onClick);
    zone.removeEventListener('keydown', onKeyDown);
    zone.removeEventListener('dragover', onDragOver);
    zone.removeEventListener('dragleave', onDragLeave);
    zone.removeEventListener('drop', onDrop);
    input.remove();
  };
}
