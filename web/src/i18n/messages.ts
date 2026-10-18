/**
 * UI 文言リソース(日本語)。
 * 基本設計書 5 章(国際化)の方針に従い、文言はここに分離する。
 * コアの進捗イベントが持つのは code のみで、文言化は本リソースで行う。
 */
export const messages = {
  appTitle: 'フォトモザイク メーカー',
  offlineBadge: 'オフライン',
  privacyNotice: '※ 画像はこの端末内でだけ処理されます',

  // S1 開始画面
  mainDropHint: 'クリックまたはここにドロップ(メイン画像を 1 枚)',
  tileHeading: '構成画像(タイル)',
  tileDropHint: '追加した画像がここにドロップできます(複数可)',
  tilesReadyHint: 'メイン画像を選択してください',
  tileRemoveLabel: (id: bigint): string => `この構成画像を削除(ID: ${id.toString()})`,

  // S2 編集画面
  editTitle: 'フォトモザイク編集',
  back: '← 戻る',
  save: '保存',
  generate: 'フォトモザイクを生成',
  cancel: 'キャンセル',
  canceling: 'キャンセルしています…',
  canceledDone: '生成をキャンセルしました',
  blockSizeLabel: 'ブロックサイズ',
  blockSizeUnit: 'px',
  tilesRequiredHint: '構成画像を追加してください',
  tileDropHintEdit: 'クリックまたはここにドロップ(構成画像を追加・複数可)',
  tileSummary: (count: number): string => `構成画像: ${count} 枚`,
  tileAdd: '+ 追加',
  tileMemoryLabel: (bytes: number): string => {
    const mib = bytes / (1024 * 1024);
    return `タイル解析結果のメモリ: ${mib >= 10 ? Math.round(mib) : mib.toFixed(1)} MB`;
  },
  previewAriaLabel: 'フォトモザイクのプレビュー',

  // 進捗表示領域
  progressTitle: '進捗表示',
  progressHide: '非表示 ▲',
  progressShow: '表示 ▼',
  progressBlocksLabel: (assigned: number, total: number, percent: number): string =>
    `${assigned.toLocaleString('ja-JP')} / ${total.toLocaleString('ja-JP')} ブロック (${percent}%)`,

  // フェーズ文言(フェーズ ID → UI 文言。詳細設計書 7.1 の対応表)
  phaseIdle: '待機中',
  phaseLoadMain: '画像を読み込み中…',
  phaseMainAnalyze: 'メイン画像を解析中…',
  phaseTileAnalyze: 'タイルを解析中…',
  phaseMatch: 'タイルをマッチング中…',
  phaseCompose: '合成中…',
  phaseExport: '保存中…',

  // エラー(インライン表示)
  errorInvalidFile: '対応していないファイル形式です(画像ファイルを指定してください)',
  errorLoadFailed: '画像の読み込みに失敗しました',
  errorGenerate: 'フォトモザイクの生成に失敗しました',
  errorStartup: 'アプリケーションの起動に失敗しました(詳細は開発者コンソールを参照)',
  tilesPartiallyAdded: (added: number, rejected: number): string =>
    `${added} 枚を追加しました(${rejected} 枚は読み込めずスキップしました)`,
  errorMemoryGuard:
    '構成画像の合計サイズが上限に達したため、追加を停止しました(不要なタイルを削除してください)',
} as const;

/**
 * コアのフェーズ識別子(詳細設計書 7.2 の code)を UI 文言へ変換する。
 * 文言はコアが持たず、この対応表のみが UI 側の情報源になる。
 */
export function phaseLabelFor(code: string): string {
  switch (code) {
    case 'main_analyze':
      return messages.phaseMainAnalyze;
    case 'tile_analyze':
      return messages.phaseTileAnalyze;
    case 'match':
      return messages.phaseMatch;
    case 'compose':
      return messages.phaseCompose;
    default:
      return messages.phaseIdle;
  }
}
