# Tabelog Draft — 食べログ下書き生成・管理アプリ

食事の写真を選ぶだけで、AIが食べログ規約に配慮した口コミ下書きを生成・管理する個人用Webアプリです。

- **写真を選ぶだけ**: EXIFから訪問日時・GPSを自動抽出し、GPS座標から店舗候補を自動提示（Google Places API）。GPSがない写真でも看板・レシートの読取で店名を推定（Gemini Vision）
- **2段階AIパイプライン・3案生成**: Gemini構造化出力で「生成→検閲」し、ハルシネーション・過剰な宣伝表現・店舗名の混入を排除した約130文字のレビューを、文体の異なる3案で作成。カードのチップでワンタップ切替
- **後から編集**: 店舗名・タイトル・コメント・評価をカード上でインライン編集。AIリライト（自由指示）にも対応
- **投稿管理**: タイトル/コメントの個別コピー、文字数警告（タイトル30文字）、食べログ/Googleマップ別の投稿完了トグル、`place_id` を使ったワンタップGoogleマップ投稿（コメント自動コピー＋投稿画面を直接オープン）
- **記憶レイヤー**: 同一店舗の再訪検知（前回評価・メモを提示、AIプロンプトにも反映）、投稿にもAIにも使わない非公開の自分用メモ、体験メモの音声入力（Web Speech API）
- **一覧の検索・並べ替え**: 店舗名・場所の部分一致検索、作成日/訪問日/評価順の並べ替え
- **グルメアルバム**: 写真の320pxサムネイルをSupabase Storage（非公開・無料枠内）に保存し、レビューカードに表示。フル解像度は保存しない軽量設計
- **PWA（ホーム画面保存）対応**: ホーム画面に追加した際、ブラウザの枠のない全画面表示（スタンドアロン）で起動可能。Gourmet Modernテーマに最適化した高解像アプリアイコン（iOSのapple-touch-icon対応）とWeb App Manifestを完備


詳細な仕様・プロンプト設計・開発履歴は [DOCUMENTATION.md](./DOCUMENTATION.md) を参照してください。

## 技術スタック

| レイヤー | 技術 |
| :--- | :--- |
| フロントエンド | Next.js (App Router) + TypeScript + Vanilla CSS |
| 認証・DB | Supabase (Auth / Postgres / RLS) |
| AI | Google Gemini API（構造化出力、既定モデル `gemini-2.0-flash`） |
| 店舗検索 | Google Places API (New) Nearby Search |
| ホスティング | Vercel（`main` へのマージで自動デプロイ） |

AI解析用の画像（長辺1200px）はブラウザでCanvasリサイズしてAPIに渡す使い捨て方式です。保存されるのは長辺320pxのサムネイルのみ（1レビュー≈最大100KB）で、Supabase Storageの無料枠1GB内に約1万レビュー分収まります。

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. 環境変数

`.env.local`（Vercelでは環境変数設定）に以下を設定します。

```bash
# Supabase（プロジェクト設定 > API から取得）
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...        # サーバー専用。クライアントに公開しない

# Google Gemini（AI生成・検閲・リライト・店舗推定）
GEMINI_API_KEY=...
# GEMINI_MODEL=gemini-2.0-flash      # 任意: モデルの上書き

# Google Places API New（GPS店舗自動特定。未設定でも候補が出ないだけで動作可）
GOOGLE_PLACES_API_KEY=...
```

`GOOGLE_PLACES_API_KEY` はGoogle Cloudで「Places API (New)」を有効化して発行し、**「Places API (New) のみ」のAPI制限**と **`SearchNearbyRequest per day` のクォータ上限（例: 100/日）** の設定を推奨します。FieldMaskをPro SKUに限定しているため、個人利用では月5,000回の無料枠内に収まります。

### 3. データベース（Supabase）

`supabase/migrations/` のSQLを日付順にすべて適用します。SupabaseダッシュボードのSQL Editorに貼り付けて実行するか、CLIで:

```bash
supabase link --project-ref <プロジェクトref>
supabase db push
```

ユーザーはSupabaseダッシュボードのAuthenticationから手動作成します（サインアップ画面はありません）。

### 4. 起動

```bash
npm run dev    # 開発サーバー (http://localhost:3000)
npm run build  # 本番ビルド
npm run lint   # ESLint
```

## 使い方

1. メール/パスワードでログイン
2. 写真を選択（最大3枚）→ 訪問日と店舗候補が自動で埋まる。GPSがない写真は「写真からお店の名前・場所を推定」ボタンで補完
3. 評価スライダー（0.2刻み）と体験メモ（任意・事実ベース、音声入力可）を入力して「AIレビューを生成する」
4. 生成された3案から好みの文体を選び、必要ならインライン編集・AIリライトで調整
5. タイトル・コメントを個別コピー、または「Googleマップに投稿」でワンタップ投稿。完了ボタンでステータス管理（再訪店なら前回情報も表示）

## プロジェクト構成

```
app/
  page.tsx               # ダッシュボード（投稿フォーム＋レビュー一覧）
  login/                 # ログイン画面
  api/generate/          # レビュー生成（2段階AIパイプライン）
  api/rewrite/           # AIリライト
  api/identify/          # 写真からの店舗推定（Gemini Vision）
  api/places/nearby/     # GPS店舗検索（Places APIプロキシ）
  apple-icon.png         # iOSホーム画面アプリアイコン (512x512)
  icon.png               # 標準アプリアイコン (512x512)
  manifest.json          # PWAマニフェスト設定
lib/
  supabase.ts            # Supabaseクライアント（anon / service role）
  auth.ts                # APIルート用のJWT検証
  gemini.ts              # Geminiモデル設定・構造化出力スキーマ・パーサー（生成/検閲/リライト/推定/3案）
  places.ts              # Places API呼び出し・距離計算
  revisit.ts             # place_idによる再訪検知（プロンプト用の要約）
supabase/migrations/     # DBスキーマ・Storageバケット（適用は手動）
```
