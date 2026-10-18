/**
 * アプリ状態(状態遷移モデル)。
 * 基本設計書 1.4 の 5 状態と遷移規則を実装する。
 *
 * 遷移ロジックは純関数 transition() に切り出し、単体テスト可能にする。
 * UI 層は本ストアを経由して状態を参照し、ビジネスロジックを持たない。
 */

/** アプリの状態(基本設計書 1.4) */
export type AppState = 'EMPTY' | 'TILES_READY' | 'MAIN_READY' | 'GENERATING' | 'DONE';

/** 状態遷移イベント(基本設計書 1.4 の遷移規則に対応) */
export type AppEvent =
  | { type: 'MAIN_IMAGE_SET' }
  | { type: 'TILES_ADDED'; count: number }
  | { type: 'TILES_REMOVED'; remaining: number }
  | { type: 'GENERATION_STARTED' }
  | { type: 'GENERATION_FINISHED' }
  | { type: 'RESET' };

/**
 * 状態遷移関数(基本設計書 1.4 の補足規則に基づく)。
 * 未定義の遷移は現在の状態をそのまま返す(無視)。
 */
export function transition(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case 'MAIN_IMAGE_SET':
      // EMPTY では S2 へ。TILES_READY ではメイン画像設定と同時に生成が自動開始する
      switch (state) {
        case 'EMPTY':
          return 'MAIN_READY';
        case 'TILES_READY':
          return 'GENERATING';
        default:
          return state;
      }
    case 'TILES_ADDED':
      if (event.count <= 0) return state;
      return state === 'EMPTY' ? 'TILES_READY' : state;
    case 'TILES_REMOVED':
      // タイルが 0 枚に戻ったら MAIN_READY へ(フォトモザイク表示は解除)
      if (event.remaining > 0) return state;
      switch (state) {
        case 'TILES_READY':
          return 'EMPTY';
        case 'GENERATING':
        case 'DONE':
          return 'MAIN_READY';
        default:
          return state;
      }
    case 'GENERATION_STARTED':
      // タイルがあり生成処理を開始できるのは MAIN_READY のみ
      return state === 'MAIN_READY' ? 'GENERATING' : state;
    case 'GENERATION_FINISHED':
      return state === 'GENERATING' ? 'DONE' : state;
    case 'RESET':
      // リセット: 全状態クリア → S1 へ
      return 'EMPTY';
    default: {
      // 網羅性チェック(未知のイベント型の追加漏れ防止)
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/** ストアが保持するデータ(状態 + 進捗表示に使う情報) */
export interface AppStoreData {
  state: AppState;
  /** メイン画像設定直後に確定する全体ブロック数(進捗バーの分母。null = 未確定) */
  totalBlocks: number | null;
  /** 割り当て済み(マッチ済み)ブロック数 */
  assignedBlocks: number;
  /** 構成画像の枚数 */
  tileCount: number;
  /** 合成用サムネイルの合計バイト数(メモリガードの監視値) */
  tilesBytes: number;
}

export const initialStoreData: AppStoreData = {
  state: 'EMPTY',
  totalBlocks: null,
  assignedBlocks: 0,
  tileCount: 0,
  tilesBytes: 0,
};

/** ストア(状態 + 通知)。UI から直接状態を書き換えさせない */
export class AppStore {
  private data: AppStoreData = { ...initialStoreData };
  private readonly listeners = new Set<(data: AppStoreData) => void>();

  getData(): AppStoreData {
    return this.data;
  }

  /** 変更通知を購読する。解除用の関数を返す */
  subscribe(listener: (data: AppStoreData) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** イベントをディスパッチし、状態遷移を反映して通知する */
  dispatch(event: AppEvent): void {
    const nextState = transition(this.data.state, event);
    if (nextState === this.data.state) {
      return;
    }
    this.data = this.reduce(this.data, event, nextState);
    this.notify();
  }

  /**
   * 全体ブロック数・割当済みブロック数を更新する(状態遷移を伴わないデータ更新)。
   * setMainImage の完了後に UI 層が呼ぶ。
   */
  setBlockCounts(totalBlocks: number, assignedBlocks: number): void {
    this.data = { ...this.data, totalBlocks, assignedBlocks };
    this.notify();
  }

  /**
   * 構成画像の枚数・メモリ使用量を更新する(状態遷移を伴わないデータ更新)。
   * タイルの追加・削除のたびに UI 層が呼ぶ。
   */
  setTileStats(tileCount: number, tilesBytes: number): void {
    this.data = { ...this.data, tileCount, tilesBytes };
    this.notify();
  }

  private reduce(data: AppStoreData, event: AppEvent, nextState: AppState): AppStoreData {
    const base: AppStoreData = { ...data, state: nextState };
    switch (event.type) {
      case 'MAIN_IMAGE_SET':
        // 実ブロック数は setMainImage 完了後に setBlockCounts で反映する
        return { ...base, assignedBlocks: 0 };
      case 'GENERATION_FINISHED':
        return { ...base, assignedBlocks: data.totalBlocks ?? data.assignedBlocks };
      case 'RESET':
        return { ...initialStoreData };
      default:
        return base;
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.data);
    }
  }
}
