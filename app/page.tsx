'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import type { User } from '@supabase/supabase-js';
import exifr from 'exifr';
import styles from './dashboard.module.css';
import {
  UtensilsCrossed,
  LogOut,
  Camera,
  Star,
  StarHalf,
  Sparkles,
  Clipboard,
  Check,
  Loader2,
  Trash2,
  CheckCircle2,
  PlusCircle,
  FileText,
  Clock,
  X,
  RefreshCw,
  Edit2,
  MapPin,
  Wand2,
  ExternalLink
} from 'lucide-react';

interface Review {
  id: string;
  user_id: string;
  shop_name: string;
  rating: number;
  raw_memo: string | null;
  generated_review: string | null;
  review_title: string | null;
  review_comment: string | null;
  status: 'processing' | 'draft' | 'failed' | 'posted_tabelog' | 'posted_google' | 'posted';
  created_at: string;
  visit_date: string | null;
  shop_location: string | null;
  latitude: number | null;
  longitude: number | null;
  place_id: string | null;
  place_lat: number | null;
  place_lng: number | null;
  photo_thumbs: string[] | null;
}

// 写真1枚分のEXIFメタデータ（撮影日時・GPS。取得できなかった項目はnull）
interface PhotoMeta {
  date: string | null;
  time: string | null;
  lat: number | null;
  lng: number | null;
}

// /api/places/nearby が返す店舗候補
interface PlaceCandidate {
  placeId: string;
  name: string;
  address: string;
  primaryType: string | null;
  lat: number;
  lng: number;
  distanceMeters: number;
}

// 第1候補を店名に自動入力してよいとみなす距離（これより遠い場合はチップ提示のみ）
const PLACE_AUTOFILL_MAX_METERS = 50;

// 食べログの口コミタイトルの上限文字数
const TABELOG_TITLE_MAX = 30;
// AIに指示しているコメント文字数の目安上限
const COMMENT_TARGET_MAX = 150;

// AI解析用リサイズと保存用サムネイルの設定
const AI_IMAGE_MAX_EDGE = 1200;
const AI_IMAGE_QUALITY = 0.85;
const THUMB_MAX_EDGE = 320;
const THUMB_QUALITY = 0.7;
// サムネイル保存先のSupabase Storageバケット（非公開・RLSで本人のみ）
const THUMBS_BUCKET = 'review-thumbs';

// 画像ファイルを長辺maxEdgeに収めたJPEGのdataURLへリサイズするヘルパー
const resizeImageFile = (file: File, maxEdge: number, quality: number): Promise<string> => {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target?.result as string;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > maxEdge) {
            height = Math.round((height * maxEdge) / width);
            width = maxEdge;
          }
        } else {
          if (height > maxEdge) {
            width = Math.round((width * maxEdge) / height);
            height = maxEdge;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvasコンテキストの取得に失敗しました'));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
    };
    reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました'));
  });
};

// テキストを同期的にクリップボードへコピーするヘルパー。
// 非同期のnavigator.clipboardはページ遷移（新規タブが開く等）と競合すると
// 失敗することがあるため、遷移を伴うボタンでは同期のexecCommandを優先する
const copyTextSync = (text: string): boolean => {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS Safari対応
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
};

// dataURL（JPEG）をStorageアップロード用のBlobへ変換するヘルパー
const dataUrlToBlob = (dataUrl: string): Blob => {
  const base64 = dataUrl.split(',')[1];
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/jpeg' });
};

// Helper function to parse title and comment from the generated review text
const parseReview = (text: string | null): { title: string; comment: string } => {
  if (!text) return { title: '', comment: '' };

  const cleanText = text.replace(/\*\*/g, '').trim();

  // Regex to match "タイトル：..." or "Title: ..."
  const titleMatch = cleanText.match(/(?:タイトル|Title)\s*[:：]\s*([^\n]+)/i);
  // Regex to match "コメント：..." or "Comment: ..."
  const commentMatch = cleanText.match(/(?:コメント|本文|Comment|Body)\s*[:：]\s*([\s\S]+)/i);

  let title = titleMatch ? titleMatch[1].trim() : '';
  let comment = commentMatch ? commentMatch[1].trim() : '';

  // Fallback if parsing fails
  if (!title && !comment) {
    const lines = cleanText.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length >= 2) {
      // Look for lines that start with Title/Comment labels but failed regex, or just take first line as title
      const firstLine = lines[0];
      const isTitleLine = firstLine.startsWith('タイトル：') || firstLine.startsWith('タイトル:') || firstLine.startsWith('Title:');
      title = isTitleLine ? firstLine.replace(/^(タイトル：|タイトル:|Title:\s*)/i, '').trim() : firstLine;
      
      const restLines = lines.slice(1);
      const firstRestLine = restLines[0];
      const isCommentLine = firstRestLine.startsWith('コメント：') || firstRestLine.startsWith('コメント:') || firstRestLine.startsWith('Comment:');
      
      let commentText = restLines.join('\n');
      if (isCommentLine) {
        commentText = restLines.map((line, idx) => 
          idx === 0 ? line.replace(/^(コメント：|コメント:|Comment:\s*)/i, '') : line
        ).join('\n');
      }
      comment = commentText.trim();
    } else {
      comment = cleanText;
    }
  }

  return { title, comment };
};

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);

  // Form states
  const [shopName, setShopName] = useState('');
  const [rating, setRating] = useState(3.0);
  const [visitDate, setVisitDate] = useState('');
  const [rawMemo, setRawMemo] = useState('');
  const [photosBase64, setPhotosBase64] = useState<string[]>([]);
  // 320px thumbnails parallel to photosBase64, uploaded to Storage on submit
  const [photoThumbsBase64, setPhotoThumbsBase64] = useState<string[]>([]);
  // Shoot date/time and GPS parallel to photosBase64, extracted from the
  // original files' EXIF (canvas resizing strips EXIF from photosBase64).
  const [photoMeta, setPhotoMeta] = useState<PhotoMeta[]>([]);
  // Visit time ('HH:MM') auto-extracted from EXIF. Not editable in the form;
  // used only to give the AI prompts time-of-day context (lunch / dinner).
  const [visitTime, setVisitTime] = useState('');

  // Place auto-identification states
  const [placeCandidates, setPlaceCandidates] = useState<PlaceCandidate[]>([]);
  const [placesLoading, setPlacesLoading] = useState(false);
  const [selectedPlace, setSelectedPlace] = useState<PlaceCandidate | null>(null);
  // True while the shop name was filled from a place candidate (not typed by the user)
  const [shopNameAutoFilled, setShopNameAutoFilled] = useState(false);
  // Set once the user types the shop name manually; blocks async auto-fill races
  const shopNameManuallyEditedRef = useRef(false);

  // AI shop identification states (photos -> shop name & location via Gemini)
  const [shopLocation, setShopLocation] = useState('');
  const [identifying, setIdentifying] = useState(false);
  const [identifyNote, setIdentifyNote] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // List states
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loadingReviews, setLoadingReviews] = useState(false);
  // Storageパス → 署名付きURL のマップ（サムネイル表示用）
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
  const [filterTab, setFilterTab] = useState<'all' | 'draft' | 'posted'>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Rewrite states
  const [openRewriteId, setOpenRewriteId] = useState<string | null>(null);
  const [rewriteInstruction, setRewriteInstruction] = useState('');
  const [rewritingId, setRewritingId] = useState<string | null>(null);
  const [rewriteError, setRewriteError] = useState<string | null>(null);

  // Shop name editing states
  const [editingShopNameId, setEditingShopNameId] = useState<string | null>(null);
  const [editShopNameValue, setEditShopNameValue] = useState('');
  const [savingShopNameId, setSavingShopNameId] = useState<string | null>(null);

  // Review title/comment inline editing states
  // editingReviewKey is `${reviewId}-title` or `${reviewId}-comment`
  const [editingReviewKey, setEditingReviewKey] = useState<string | null>(null);
  const [editReviewValue, setEditReviewValue] = useState('');
  const [savingReviewKey, setSavingReviewKey] = useState<string | null>(null);

  // Rating inline editing states
  const [editingRatingId, setEditingRatingId] = useState<string | null>(null);
  const [editRatingValue, setEditRatingValue] = useState(3.0);
  const [savingRatingId, setSavingRatingId] = useState<string | null>(null);

  // サムネイルの署名付きURLをまとめて取得するヘルパー（ベストエフォート。
  // バケット未作成・取得失敗時は該当サムネイルが表示されないだけでカードは正常表示）
  const loadThumbUrls = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    try {
      const { data, error } = await supabase.storage
        .from(THUMBS_BUCKET)
        .createSignedUrls(paths, 3600);
      if (error || !data) {
        console.warn('Failed to create signed URLs for thumbnails:', error);
        return;
      }
      setThumbUrls(prev => {
        const next = { ...prev };
        for (const item of data) {
          if (item.path && item.signedUrl) next[item.path] = item.signedUrl;
        }
        return next;
      });
    } catch (err) {
      console.warn('Failed to load thumbnail URLs:', err);
    }
  }, []);

  // Fetch reviews list
  const fetchReviews = useCallback(async (userId: string) => {
    setLoadingReviews(true);
    try {
      const { data, error } = await supabase
        .from('tabelog_reviews')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error fetching reviews:', error);
      } else {
        setReviews(data || []);
        loadThumbUrls((data || []).flatMap((r: Review) => r.photo_thumbs || []));
      }
    } catch (err: unknown) {
      console.error(err);
    } finally {
      setLoadingReviews(false);
    }
  }, [loadThumbUrls]);

  // Check authentication
  useEffect(() => {
    const checkAuth = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.push('/login');
      } else {
        setUser(session.user);
        fetchReviews(session.user.id);
      }
      setLoadingUser(false);
    };

    checkAuth();
  }, [router, fetchReviews]);

  // Logout handler
  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push('/login');
  };

  // 元ファイルのEXIFから撮影日時（YYYY-MM-DD / HH:MM）とGPS座標を抽出するヘルパー
  // ※リサイズ後のCanvas画像はEXIFが失われるため、必ずFileから読み取る
  const extractPhotoMeta = async (file: File): Promise<PhotoMeta> => {
    const meta: PhotoMeta = { date: null, time: null, lat: null, lng: null };
    try {
      const output = await exifr.parse(file, ['DateTimeOriginal']);
      if (output && output.DateTimeOriginal) {
        const localDate = new Date(output.DateTimeOriginal);
        if (!isNaN(localDate.getTime())) {
          const yyyy = localDate.getFullYear();
          const mm = String(localDate.getMonth() + 1).padStart(2, '0');
          const dd = String(localDate.getDate()).padStart(2, '0');
          const hh = String(localDate.getHours()).padStart(2, '0');
          const min = String(localDate.getMinutes()).padStart(2, '0');
          meta.date = `${yyyy}-${mm}-${dd}`;
          meta.time = `${hh}:${min}`;
        }
      }
    } catch (err) {
      console.warn('Failed to parse EXIF from photo:', err);
    }
    try {
      const gps = await exifr.gps(file);
      if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
        meta.lat = gps.latitude;
        meta.lng = gps.longitude;
      }
    } catch (err) {
      console.warn('Failed to parse GPS from photo:', err);
    }
    return meta;
  };

  // 登録されている写真の撮影日時リストから訪問日・時刻を自動更新するヘルパー
  // 1枚目（インデックス0）から優先的に採用。撮影日を持つ写真がなければ
  // 手入力の値を壊さないよう据え置き、写真が0枚になったらクリアする
  const applyVisitDateFromPhotoMeta = (currentMeta: PhotoMeta[]) => {
    if (currentMeta.length === 0) {
      setVisitDate('');
      setVisitTime('');
      return;
    }
    const found = currentMeta.find(m => m.date !== null);
    if (found && found.date) {
      setVisitDate(found.date);
      setVisitTime(found.time || '');
    }
  };

  // 写真のGPS座標から周辺の店舗候補を取得し、条件を満たせば店名を自動入力する
  // 失敗時は静かに手入力へフォールバック（生成フローを止めない）
  const fetchPlaceCandidates = async (lat: number, lng: number) => {
    setPlacesLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      const response = await fetch('/api/places/nearby', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ lat, lng }),
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || '店舗候補の取得に失敗しました');
      }

      const candidates: PlaceCandidate[] = result.candidates || [];
      setPlaceCandidates(candidates);

      // 十分近い第1候補のみ自動入力（手入力済み・入力中の場合は上書きしない）
      if (
        candidates.length > 0 &&
        candidates[0].distanceMeters <= PLACE_AUTOFILL_MAX_METERS &&
        !shopNameManuallyEditedRef.current
      ) {
        setShopName(candidates[0].name);
        setSelectedPlace(candidates[0]);
        setShopNameAutoFilled(true);
        // 正確な住所（Google Places由来）で場所欄も補完する（空欄のみ）
        setShopLocation(prev => prev.trim() ? prev : candidates[0].address);
      }
    } catch (err) {
      console.warn('Failed to fetch place candidates:', err);
    } finally {
      setPlacesLoading(false);
    }
  };

  // 店名の手入力（自動入力の解除を兼ねる）
  const handleShopNameChange = (value: string) => {
    setShopName(value);
    shopNameManuallyEditedRef.current = true;
    setShopNameAutoFilled(false);
    setSelectedPlace(null);
  };

  // 候補チップの選択
  const handleSelectPlaceCandidate = (candidate: PlaceCandidate) => {
    setShopName(candidate.name);
    setSelectedPlace(candidate);
    setShopNameAutoFilled(true);
    shopNameManuallyEditedRef.current = false;
    // 場所欄が空なら候補の住所で補完する（入力済みの場所は上書きしない）
    setShopLocation(prev => prev.trim() ? prev : candidate.address);
  };

  // 写真からお店の名前と場所をAI（Gemini Vision）で推定し、フォームに反映する
  // 看板・レシート等の文字を読み取るため、GPSのない写真でも動作する
  // ※GPS座標は渡さない（LLMは座標から地名を復元できず誤った住所を生成するため。
  //   GPSがある場合の正確な住所はPlaces API候補から取得する）
  const handleIdentifyShop = async () => {
    if (photosBase64.length === 0) return;

    setIdentifying(true);
    setFormError(null);
    setIdentifyNote(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      const response = await fetch('/api/identify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          images_base64: photosBase64,
        }),
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'お店の推定に失敗しました');
      }

      if (result.shop_name) {
        // ボタン押下による明示的な推定なので店名を上書きし、
        // 以後のPlaces候補による自動入力はブロックする（チップのタップは引き続き有効）
        setShopName(result.shop_name);
        setSelectedPlace(null);
        setShopNameAutoFilled(false);
        shopNameManuallyEditedRef.current = true;
      }
      if (result.location) {
        // Places候補由来・手入力済みの場所は正確なので上書きしない（空欄のみ補完）
        setShopLocation(prev => prev.trim() ? prev : result.location);
      }

      if (!result.shop_name && !result.location) {
        setIdentifyNote('写真からお店を特定できませんでした。店舗名を手入力してください。');
      } else {
        const confLabel = result.confidence === 'high' ? '高' : result.confidence === 'medium' ? '中' : '低';
        setIdentifyNote(`AIによる推定です（信頼度：${confLabel}）。内容を確認・修正してください。`);
      }
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : '予期せぬエラーが発生しました');
    } finally {
      setIdentifying(false);
    }
  };

  // Client-side image resizing and base64 encoding (multiple files)
  const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setFormError(null);
    const newFiles = Array.from(files);

    if (photosBase64.length + newFiles.length > 3) {
      setFormError('画像は最大3枚までアップロードできます');
      return;
    }

    try {
      const [base64s, thumbs, metas] = await Promise.all([
        Promise.all(newFiles.map(file => resizeImageFile(file, AI_IMAGE_MAX_EDGE, AI_IMAGE_QUALITY))),
        Promise.all(newFiles.map(file => resizeImageFile(file, THUMB_MAX_EDGE, THUMB_QUALITY))),
        Promise.all(newFiles.map(file => extractPhotoMeta(file))),
      ]);
      const updatedMeta = [...photoMeta, ...metas];
      setPhotosBase64(prev => [...prev, ...base64s]);
      setPhotoThumbsBase64(prev => [...prev, ...thumbs]);
      setPhotoMeta(updatedMeta);
      applyVisitDateFromPhotoMeta(updatedMeta);

      // GPSを持つ最初の写真から店舗候補を検索（店名を手入力済みの場合は行わない）
      const gpsMeta = updatedMeta.find(m => m.lat !== null && m.lng !== null);
      if (gpsMeta && !shopNameManuallyEditedRef.current && placeCandidates.length === 0) {
        fetchPlaceCandidates(gpsMeta.lat as number, gpsMeta.lng as number);
      }
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : '画像の処理中にエラーが発生しました');
    }

    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleRemovePhoto = (index: number) => {
    const updatedMeta = photoMeta.filter((_, i) => i !== index);
    setPhotosBase64(prev => prev.filter((_, i) => i !== index));
    setPhotoThumbsBase64(prev => prev.filter((_, i) => i !== index));
    setPhotoMeta(updatedMeta);
    applyVisitDateFromPhotoMeta(updatedMeta);

    // 写真が0枚になったら、写真由来の自動入力・候補をクリアする
    // （手入力した店名・場所は保持する — 訪問日と同じ思想）
    if (updatedMeta.length === 0) {
      setPlaceCandidates([]);
      setIdentifyNote(null);
      if (shopNameAutoFilled) {
        setShopName('');
        setSelectedPlace(null);
        setShopNameAutoFilled(false);
        shopNameManuallyEditedRef.current = false;
      }
    }
  };

  // サムネイルをStorageへ保存し、成功したパスをレコードに記録するヘルパー
  // ベストエフォート: 失敗してもレビュー生成フローには影響させない
  const uploadThumbnails = async (userId: string, reviewId: string, thumbs: string[]) => {
    try {
      const paths: string[] = [];
      await Promise.all(thumbs.map(async (thumb, index) => {
        const path = `${userId}/${reviewId}/${index}.jpg`;
        const { error } = await supabase.storage
          .from(THUMBS_BUCKET)
          .upload(path, dataUrlToBlob(thumb), { contentType: 'image/jpeg', upsert: true });
        if (error) {
          console.warn('Failed to upload thumbnail:', error);
          return;
        }
        paths.push(path);
      }));

      if (paths.length === 0) return;
      paths.sort();

      const { error: updateError } = await supabase
        .from('tabelog_reviews')
        .update({ photo_thumbs: paths })
        .eq('id', reviewId);
      if (updateError) {
        console.warn('Failed to save thumbnail paths:', updateError);
        return;
      }

      await loadThumbUrls(paths);
      setReviews(prev =>
        prev.map(r => (r.id === reviewId ? { ...r, photo_thumbs: paths } : r))
      );
    } catch (err) {
      console.warn('Thumbnail upload skipped:', err);
    }
  };

  // Submit and trigger API route
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) {
      setFormError('ユーザー情報が取得できません。再ログインしてください。');
      return;
    }
    if (!shopName) {
      setFormError('店舗名を入力してください');
      return;
    }
    if (photosBase64.length === 0) {
      setFormError('写真をアップロードしてください');
      return;
    }

    setGenerating(true);
    setFormError(null);

    try {
      const firstGps = photoMeta.find(m => m.lat !== null && m.lng !== null) || null;

      // 1. Create a draft record in database
      const { data: insertedReview, error: insertError } = await supabase
        .from('tabelog_reviews')
        .insert({
          user_id: user.id,
          shop_name: shopName,
          rating: rating,
          visit_date: visitDate || null,
          visit_time: (visitDate && visitTime) ? visitTime : null,
          raw_memo: rawMemo || null,
          place_id: selectedPlace?.placeId ?? null,
          place_lat: selectedPlace?.lat ?? null,
          place_lng: selectedPlace?.lng ?? null,
          place_genre: selectedPlace?.primaryType ?? null,
          shop_location: shopLocation.trim() || null,
          latitude: firstGps ? firstGps.lat : null,
          longitude: firstGps ? firstGps.lng : null,
          status: 'processing',
        })
        .select()
        .single();

      if (insertError) {
        throw new Error(`DB保存エラー: ${insertError.message}`);
      }

      // Refresh list immediately so user sees 'processing' state
      setReviews(prev => [insertedReview, ...prev]);

      // Copy local variables to send in fetch
      const payloadImages = [...photosBase64];
      const payloadThumbs = [...photoThumbsBase64];

      // サムネイルの保存はAI生成と並行してベストエフォートで行う（awaitしない）
      uploadThumbnails(user.id, insertedReview.id, payloadThumbs);

      // Clear input fields during processing
      setShopName('');
      setRating(3.0);
      setVisitDate('');
      setVisitTime('');
      setRawMemo('');
      setPhotosBase64([]);
      setPhotoThumbsBase64([]);
      setPhotoMeta([]);
      setPlaceCandidates([]);
      setSelectedPlace(null);
      setShopNameAutoFilled(false);
      shopNameManuallyEditedRef.current = false;
      setShopLocation('');
      setIdentifyNote(null);
      if (fileInputRef.current) fileInputRef.current.value = '';

      // 2. Fetch session and tokens
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      // 3. Request review generation from Next.js server API
      // (shop_name / rating / raw_memo are read from the DB on the server side)
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          review_id: insertedReview.id,
          images_base64: payloadImages,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        // Mark the record as failed so it does not stay stuck in 'processing'.
        // (The server also does this, but it cannot for errors that occur
        // before the ownership check, e.g. an expired token.)
        await supabase
          .from('tabelog_reviews')
          .update({ status: 'failed' })
          .eq('id', insertedReview.id);
        throw new Error(result.error || 'レビュー生成に失敗しました');
      }

      // 4. Reload lists to get final review
      fetchReviews(user.id);

    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : '予期せぬエラーが発生しました');
      if (user) fetchReviews(user.id);
    } finally {
      setGenerating(false);
    }
  };

  // Toggle the posted state of a review for a specific platform
  const handleTogglePlatformPosted = async (reviewId: string, platform: 'tabelog' | 'google') => {
    const review = reviews.find(r => r.id === reviewId);
    if (!review) return;

    const tabelogDone = review.status === 'posted_tabelog' || review.status === 'posted';
    const googleDone = review.status === 'posted_google' || review.status === 'posted';

    const nextTabelog = platform === 'tabelog' ? !tabelogDone : tabelogDone;
    const nextGoogle = platform === 'google' ? !googleDone : googleDone;

    const nextStatus: Review['status'] =
      nextTabelog && nextGoogle ? 'posted'
      : nextTabelog ? 'posted_tabelog'
      : nextGoogle ? 'posted_google'
      : 'draft';

    try {
      const { error } = await supabase
        .from('tabelog_reviews')
        .update({ status: nextStatus })
        .eq('id', reviewId);

      if (error) throw error;

      setReviews(prev =>
        prev.map(r => (r.id === reviewId ? { ...r, status: nextStatus } : r))
      );
    } catch (err: unknown) {
      console.error('Failed to update status:', err);
      alert(err instanceof Error ? err.message : 'ステータスの更新に失敗しました');
    }
  };

  // Delete a review card
  const handleDeleteReview = async (reviewId: string) => {
    if (!confirm('この下書きを削除してもよろしいですか？')) return;

    const target = reviews.find(r => r.id === reviewId);

    try {
      const { error } = await supabase
        .from('tabelog_reviews')
        .delete()
        .eq('id', reviewId);

      if (error) throw error;

      setReviews(prev => prev.filter(r => r.id !== reviewId));

      // Storage上のサムネイルもベストエフォートで削除（失敗しても孤児として許容）
      if (target?.photo_thumbs && target.photo_thumbs.length > 0) {
        supabase.storage
          .from(THUMBS_BUCKET)
          .remove(target.photo_thumbs)
          .then(({ error: removeError }) => {
            if (removeError) console.warn('Failed to delete thumbnails:', removeError);
          });
      }
    } catch (err: unknown) {
      console.error('Failed to delete review:', err);
      alert(err instanceof Error ? err.message : '下書きの削除に失敗しました');
    }
  };

  // Rewrite review text based on AI prompt
  const handleRewrite = async (reviewId: string) => {
    if (!rewriteInstruction.trim()) return;

    setRewritingId(reviewId);
    setRewriteError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      const response = await fetch('/api/rewrite', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          review_id: reviewId,
          instruction: rewriteInstruction,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'リライトに失敗しました');
      }

      // Close and reset states
      setOpenRewriteId(null);
      setRewriteInstruction('');
      
      // Reload lists
      if (user) {
        fetchReviews(user.id);
      }
    } catch (err: unknown) {
      setRewriteError(err instanceof Error ? err.message : '予期せぬエラーが発生しました');
    } finally {
      setRewritingId(null);
    }
  };

  // Start shop name editing
  const handleStartEditShopName = (reviewId: string, currentName: string) => {
    setEditingShopNameId(reviewId);
    setEditShopNameValue(currentName);
  };

  // Cancel shop name editing
  const handleCancelEditShopName = () => {
    setEditingShopNameId(null);
    setEditShopNameValue('');
  };

  // Save modified shop name to Supabase
  const handleSaveShopName = async (reviewId: string) => {
    const trimmedName = editShopNameValue.trim();
    if (!trimmedName) return;

    setSavingShopNameId(reviewId);
    try {
      const { error } = await supabase
        .from('tabelog_reviews')
        .update({ shop_name: trimmedName })
        .eq('id', reviewId);

      if (error) throw error;

      setReviews(prev =>
        prev.map(r => (r.id === reviewId ? { ...r, shop_name: trimmedName } : r))
      );
      setEditingShopNameId(null);
      setEditShopNameValue('');
    } catch (err: unknown) {
      console.error('Failed to update shop name:', err);
      alert(err instanceof Error ? err.message : '店舗名の更新に失敗しました');
    } finally {
      setSavingShopNameId(null);
    }
  };

  // Start rating editing
  const handleStartEditRating = (review: Review) => {
    setEditingRatingId(review.id);
    setEditRatingValue(Number(review.rating));
  };

  // Cancel rating editing
  const handleCancelEditRating = () => {
    setEditingRatingId(null);
  };

  // Save modified rating to Supabase
  const handleSaveRating = async (reviewId: string) => {
    setSavingRatingId(reviewId);
    try {
      const { error } = await supabase
        .from('tabelog_reviews')
        .update({ rating: editRatingValue })
        .eq('id', reviewId);

      if (error) throw error;

      setReviews(prev =>
        prev.map(r => (r.id === reviewId ? { ...r, rating: editRatingValue } : r))
      );
      setEditingRatingId(null);
    } catch (err: unknown) {
      console.error('Failed to update rating:', err);
      alert(err instanceof Error ? err.message : '評価の更新に失敗しました');
    } finally {
      setSavingRatingId(null);
    }
  };

  // Resolve a review's current title/comment (structured columns first,
  // regex-parsed legacy text as fallback). Shared by render and edit handlers.
  const getReviewParts = useCallback((review: Review): { title: string; comment: string } => {
    if (review.review_title || review.review_comment) {
      return { title: review.review_title || '', comment: review.review_comment || '' };
    }
    return parseReview(review.generated_review);
  }, []);

  // Start editing a review's title or comment
  const handleStartEditReview = (review: Review, field: 'title' | 'comment') => {
    const { title, comment } = getReviewParts(review);
    setEditingReviewKey(`${review.id}-${field}`);
    setEditReviewValue(field === 'title' ? title : comment);
  };

  // Cancel review editing
  const handleCancelEditReview = () => {
    setEditingReviewKey(null);
    setEditReviewValue('');
  };

  // Save an edited review title/comment to Supabase.
  // Writes the structured columns and keeps generated_review in the legacy
  // "タイトル：…\nコメント：…" format for backward compatibility.
  const handleSaveReview = async (review: Review, field: 'title' | 'comment') => {
    const trimmed = editReviewValue.trim();
    if (!trimmed) return;

    const current = getReviewParts(review);
    const nextTitle = field === 'title' ? trimmed : current.title;
    const nextComment = field === 'comment' ? trimmed : current.comment;

    const key = `${review.id}-${field}`;
    setSavingReviewKey(key);
    try {
      const { error } = await supabase
        .from('tabelog_reviews')
        .update({
          review_title: nextTitle,
          review_comment: nextComment,
          generated_review: `タイトル：${nextTitle}\nコメント：${nextComment}`,
        })
        .eq('id', review.id);

      if (error) throw error;

      setReviews(prev =>
        prev.map(r =>
          r.id === review.id
            ? {
                ...r,
                review_title: nextTitle,
                review_comment: nextComment,
                generated_review: `タイトル：${nextTitle}\nコメント：${nextComment}`,
              }
            : r
        )
      );
      setEditingReviewKey(null);
      setEditReviewValue('');
    } catch (err: unknown) {
      console.error('Failed to update review:', err);
      alert(err instanceof Error ? err.message : 'レビューの更新に失敗しました');
    } finally {
      setSavingReviewKey(null);
    }
  };

  // Copy to clipboard helper
  const handleCopyToClipboard = (text: string, copyKey: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(copyKey);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  // Helper to render fractional stars (0.2 step)
  const renderStars = useCallback((val: number, size: number = 28) => {
    const stars = [];
    for (let i = 1; i <= 5; i++) {
      if (val >= i) {
        stars.push(<Star key={i} size={size} fill="var(--secondary)" color="var(--secondary)" className={styles.starIcon} />);
      } else if (val >= i - 0.7) {
        stars.push(<StarHalf key={i} size={size} fill="var(--secondary)" color="var(--secondary)" className={styles.starIcon} />);
      } else {
        stars.push(<Star key={i} size={size} fill="none" color="var(--text-muted)" className={styles.starIcon} />);
      }
    }
    return stars;
  }, []);

  // Memoized review counts (single pass)
  const reviewCounts = useMemo(() => {
    let draft = 0;
    let posted = 0;
    for (const r of reviews) {
      if (r.status === 'draft' || r.status === 'failed' || r.status === 'posted_tabelog' || r.status === 'posted_google') draft++;
      else if (r.status === 'posted') posted++;
    }
    return { all: reviews.length, draft, posted };
  }, [reviews]);

  // Memoized filtered reviews
  const filteredReviews = useMemo(() => {
    if (filterTab === 'all') return reviews;
    if (filterTab === 'draft') {
      return reviews.filter(r =>
        r.status === 'draft' || r.status === 'failed' || r.status === 'posted_tabelog' || r.status === 'posted_google'
      );
    }
    if (filterTab === 'posted') {
      return reviews.filter(r => r.status === 'posted');
    }
    return reviews;
  }, [reviews, filterTab]);

  if (loadingUser) {
    return (
      <div className={styles.loadingScreen}>
        <Loader2 className={styles.spinner} size={40} />
        <p>認証情報を確認中...</p>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="container">
      {/* Header Bar */}
      <header className={`${styles.header} glass-card`}>
        <div className={styles.brand}>
          <div className={styles.logoIcon}>
            <UtensilsCrossed size={22} color="var(--primary)" />
          </div>
          <div>
            <h1 className={`${styles.headerTitle} gradient-text`}>Tabelog Draft</h1>
            <p className={styles.headerSubtitle}>for Gourmet Reviews</p>
          </div>
        </div>
        
        <div className={styles.userInfo}>
          <span className={styles.userEmail}>{user?.email}</span>
          <button onClick={handleLogout} className="btn btn-secondary" title="ログアウト">
            <LogOut size={16} />
            <span className={styles.logoutText}>ログアウト</span>
          </button>
        </div>
      </header>

      {/* Main Grid */}
      <div className={styles.mainGrid}>
        
        {/* Left Side: Creation Form */}
        <section className={styles.formSection}>
          <div className="glass-card">
            <h2 className={styles.sectionTitle}>
              <PlusCircle size={20} className={styles.titleIcon} />
              下書きレビューの作成
            </h2>
            
            {formError && <div className={styles.formError}>{formError}</div>}

            <form onSubmit={handleSubmit} className={styles.reviewForm}>
              
              <div className="form-group">
                <label className="form-label">店舗名 <span className={styles.required}>*</span></label>
                <input
                  type="text"
                  required
                  placeholder="例：銀座 うかい亭（写真から自動入力されます）"
                  className="form-control"
                  value={shopName}
                  onChange={(e) => handleShopNameChange(e.target.value)}
                  disabled={generating}
                />
                {placesLoading && (
                  <div className={styles.placeLoading}>
                    <Loader2 className={styles.spinner} size={13} />
                    <span>写真の位置情報からお店を探しています...</span>
                  </div>
                )}
                {!placesLoading && placeCandidates.length > 0 && (
                  <div className={styles.placeCandidates}>
                    <span className={styles.placeCandidatesLabel}>
                      <MapPin size={12} />
                      候補:
                    </span>
                    {placeCandidates.map((candidate) => (
                      <button
                        type="button"
                        key={candidate.placeId}
                        onClick={() => handleSelectPlaceCandidate(candidate)}
                        className={`${styles.placeChip} ${selectedPlace?.placeId === candidate.placeId ? styles.placeChipActive : ''}`}
                        disabled={generating}
                        title={candidate.address}
                      >
                        <span className={styles.placeChipName}>{candidate.name}</span>
                        <span className={styles.placeDistance}>{Math.round(candidate.distanceMeters)}m</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="form-group">
                <label className="form-label">評価（5段階・0.2刻み）<span className={styles.required}>*</span></label>
                <div className={styles.starRatingContainer}>
                  <div className={styles.starsWrapper}>
                    {renderStars(rating)}
                  </div>
                  <input
                    type="range"
                    min="1.0"
                    max="5.0"
                    step="0.2"
                    className={styles.ratingSlider}
                    value={rating}
                    onChange={(e) => setRating(parseFloat(e.target.value))}
                    disabled={generating}
                  />
                  <span className={styles.ratingValue}>{rating.toFixed(1)}</span>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">写真（最大3枚）<span className={styles.required}>*</span></label>
                <div className={styles.photoUploadGroup}>
                  {photosBase64.map((base64, index) => (
                    <div key={index} className={styles.photoPreviewCard}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={base64} alt={`Upload preview ${index + 1}`} className={styles.photoPreviewMini} />
                      <button
                        type="button"
                        className={styles.removePhotoBtn}
                        onClick={() => handleRemovePhoto(index)}
                        disabled={generating}
                        title="画像を削除"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                  
                  {photosBase64.length < 3 && (
                    <div className={styles.photoUploadArea}>
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        ref={fileInputRef}
                        className={styles.fileInput}
                        onChange={handlePhotoChange}
                        id="photo-upload-input"
                        disabled={generating}
                      />
                      <label htmlFor="photo-upload-input" className={styles.photoUploadLabel}>
                        <div className={styles.photoUploadPlaceholder}>
                          <Camera size={26} className={styles.uploadIcon} />
                          <span className={styles.uploadText}>写真を追加 ({photosBase64.length}/3)</span>
                        </div>
                      </label>
                    </div>
                  )}
                </div>

                {photosBase64.length > 0 && (
                  <>
                    <button
                      type="button"
                      className={`btn btn-secondary ${styles.identifyBtn}`}
                      onClick={handleIdentifyShop}
                      disabled={generating || identifying}
                    >
                      {identifying ? (
                        <>
                          <Loader2 className={styles.spinner} size={16} />
                          <span>写真を解析中...</span>
                        </>
                      ) : (
                        <>
                          <Wand2 size={16} />
                          <span>写真からお店の名前・場所を推定</span>
                        </>
                      )}
                    </button>
                    {identifyNote && (
                      <p className={styles.identifyNote}>{identifyNote}</p>
                    )}
                  </>
                )}
              </div>

              <div className="form-group">
                <label className="form-label">場所</label>
                <input
                  type="text"
                  placeholder="例：東京都中央区銀座付近（写真から自動推定できます）"
                  className="form-control"
                  value={shopLocation}
                  onChange={(e) => setShopLocation(e.target.value)}
                  disabled={generating}
                />
                {(() => {
                  const gps = photoMeta.find(m => m.lat !== null && m.lng !== null);
                  return gps ? (
                    <a
                      href={`https://www.google.com/maps/search/?api=1&query=${gps.lat},${gps.lng}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.gpsMapLink}
                    >
                      <MapPin size={12} />
                      <span>写真の撮影地点を地図で確認</span>
                    </a>
                  ) : null;
                })()}
              </div>

              <div className="form-group">
                <label className="form-label">訪問日</label>
                <input
                  type="date"
                  className="form-control"
                  value={visitDate}
                  onChange={(e) => setVisitDate(e.target.value)}
                  disabled={generating}
                />
              </div>

              <div className="form-group">
                <label className="form-label">体験メモ（任意・事実ベース）</label>
                <textarea
                  placeholder="例：
・ローストビーフが美味しかった
・前菜はホタテのマリネ
・日曜日のランチで利用
・盛り付けが綺麗だった"
                  rows={4}
                  className="form-control"
                  style={{ resize: 'vertical' }}
                  value={rawMemo}
                  onChange={(e) => setRawMemo(e.target.value)}
                  disabled={generating}
                />
              </div>

              <button
                type="submit"
                className="btn btn-primary"
                style={{ width: '100%', marginTop: '0.5rem' }}
                disabled={generating || !shopName || photosBase64.length === 0}
              >
                {generating ? (
                  <>
                    <Loader2 className={styles.spinner} size={18} />
                    <span>レビュー生成中...</span>
                  </>
                ) : (
                  <>
                    <Sparkles size={18} />
                    <span>AIレビューを生成する</span>
                  </>
                )}
              </button>

            </form>
          </div>
        </section>

        {/* Right Side: Draft list */}
        <section className={styles.listSection}>
          <div className={styles.listTabs}>
            <button
              onClick={() => setFilterTab('all')}
              className={`${styles.tabBtn} ${filterTab === 'all' ? styles.activeTab : ''}`}
            >
              すべて ({reviewCounts.all})
            </button>
            <button
              onClick={() => setFilterTab('draft')}
              className={`${styles.tabBtn} ${filterTab === 'draft' ? styles.activeTab : ''}`}
            >
              未投稿 ({reviewCounts.draft})
            </button>
            <button
              onClick={() => setFilterTab('posted')}
              className={`${styles.tabBtn} ${filterTab === 'posted' ? styles.activeTab : ''}`}
            >
              投稿完了 ({reviewCounts.posted})
            </button>
          </div>

          <div className={styles.reviewList}>
            {loadingReviews && reviews.length === 0 ? (
              <div className={styles.listEmptyState}>
                <Loader2 className={styles.spinner} size={28} />
                <p>レビューを取得中...</p>
              </div>
            ) : filteredReviews.length === 0 ? (
              <div className={`${styles.listEmptyState} glass-card`}>
                <FileText size={40} className={styles.emptyIcon} />
                <p>対象のレビューはありません。</p>
              </div>
            ) : (
              filteredReviews.map((review) => (
                <div key={review.id} className={`${styles.reviewCard} glass-card`}>
                  
                  <div className={styles.cardHeader}>
                    <div>
                      {editingShopNameId === review.id ? (
                        <div className={styles.editShopNameForm}>
                          <input
                            type="text"
                            value={editShopNameValue}
                            onChange={(e) => setEditShopNameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveShopName(review.id);
                              if (e.key === 'Escape') handleCancelEditShopName();
                            }}
                            className={styles.editShopNameInput}
                            autoFocus
                            disabled={savingShopNameId === review.id}
                          />
                          <button
                            type="button"
                            onClick={() => handleSaveShopName(review.id)}
                            className={`${styles.saveShopNameBtn}`}
                            disabled={savingShopNameId === review.id || !editShopNameValue.trim()}
                            title="保存"
                          >
                            {savingShopNameId === review.id ? (
                              <Loader2 className={styles.spinner} size={13} />
                            ) : (
                              <Check size={13} />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={handleCancelEditShopName}
                            className={`${styles.cancelShopNameBtn}`}
                            disabled={savingShopNameId === review.id}
                            title="キャンセル"
                          >
                            <X size={13} />
                          </button>
                        </div>
                      ) : (
                        <div className={styles.shopNameWrapper}>
                          <h3 className={styles.cardShopName}>
                            <a
                              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(review.shop_name)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={styles.shopMapLink}
                              title="Googleマップで場所を表示"
                            >
                              {review.shop_name}
                            </a>
                          </h3>
                          {review.status !== 'processing' && (
                            <button
                              type="button"
                              onClick={() => handleStartEditShopName(review.id, review.shop_name)}
                              className={styles.editShopNameBtn}
                              title="店舗名を編集"
                              aria-label="店舗名を編集"
                            >
                              <Edit2 size={13} />
                            </button>
                          )}
                        </div>
                      )}
                        <div className={styles.cardMeta}>
                          {editingRatingId === review.id ? (
                            <div className={styles.editRatingForm}>
                              {renderStars(editRatingValue, 14)}
                              <input
                                type="range"
                                min="1.0"
                                max="5.0"
                                step="0.2"
                                value={editRatingValue}
                                onChange={(e) => setEditRatingValue(parseFloat(e.target.value))}
                                className={`${styles.ratingSlider} ${styles.editRatingSlider}`}
                                disabled={savingRatingId === review.id}
                                aria-label="評価を変更"
                              />
                              <span className={styles.cardRatingValue}>{editRatingValue.toFixed(1)}</span>
                              <button
                                type="button"
                                onClick={() => handleSaveRating(review.id)}
                                className={styles.saveShopNameBtn}
                                disabled={savingRatingId === review.id}
                                title="保存"
                              >
                                {savingRatingId === review.id ? (
                                  <Loader2 className={styles.spinner} size={13} />
                                ) : (
                                  <Check size={13} />
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={handleCancelEditRating}
                                className={styles.cancelShopNameBtn}
                                disabled={savingRatingId === review.id}
                                title="キャンセル"
                              >
                                <X size={13} />
                              </button>
                            </div>
                          ) : (
                            <div className={styles.cardStars}>
                              {renderStars(review.rating, 14)}
                              <span className={styles.cardRatingValue}>{Number(review.rating).toFixed(1)}</span>
                              {review.status !== 'processing' && (
                                <button
                                  type="button"
                                  onClick={() => handleStartEditRating(review)}
                                  className={styles.editShopNameBtn}
                                  title="評価を編集"
                                  aria-label="評価を編集"
                                >
                                  <Edit2 size={12} />
                                </button>
                              )}
                            </div>
                          )}
                          {review.visit_date && (
                            <>
                              <span className={styles.metaDivider}>|</span>
                              <span className={styles.cardDate}>
                                訪問日: {new Date(review.visit_date).toLocaleDateString('ja-JP', {
                                  year: 'numeric',
                                  month: '2-digit',
                                  day: '2-digit'
                                })}
                              </span>
                            </>
                          )}
                          {review.shop_location && (() => {
                            // 座標は選択された店舗（Places）を優先し、なければ写真のGPS
                            const lat = review.place_lat ?? review.latitude;
                            const lng = review.place_lng ?? review.longitude;
                            return (
                              <>
                                <span className={styles.metaDivider}>|</span>
                                {lat != null && lng != null ? (
                                  <a
                                    href={`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={styles.cardLocationLink}
                                    title="地図で場所を確認"
                                  >
                                    <MapPin size={11} />
                                    <span>{review.shop_location}</span>
                                  </a>
                                ) : (
                                  <span className={styles.cardLocation}>
                                    <MapPin size={11} />
                                    <span>{review.shop_location}</span>
                                  </span>
                                )}
                              </>
                            );
                          })()}
                          <span className={styles.metaDivider}>|</span>
                          <span className={styles.cardDate}>
                            作成: {new Date(review.created_at).toLocaleDateString('ja-JP', {
                              year: 'numeric',
                              month: '2-digit',
                              day: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit'
                            })}
                          </span>
                        <span className={styles.metaDivider}>|</span>
                        <a
                          href={`https://www.google.com/search?q=${encodeURIComponent(review.shop_name + ' 食べログ')}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={styles.tabelogSearchLink}
                          title="食べログで店舗を検索"
                        >
                          食べログで検索
                        </a>
                      </div>
                    </div>

                    <span className={`${styles.statusBadge} ${styles[review.status]}`}>
                      {review.status === 'processing' && (
                        <>
                          <Loader2 className={styles.spinner} size={12} />
                          <span>生成中...</span>
                        </>
                      )}
                      {review.status === 'draft' && (
                        <>
                          <Clock size={12} />
                          <span>未投稿</span>
                        </>
                      )}
                      {review.status === 'failed' && (
                        <>
                          <X size={12} />
                          <span>生成失敗</span>
                        </>
                      )}
                      {review.status === 'posted_tabelog' && (
                        <>
                          <CheckCircle2 size={12} color="var(--primary)" />
                          <span>食べログ済</span>
                        </>
                      )}
                      {review.status === 'posted_google' && (
                        <>
                          <CheckCircle2 size={12} color="var(--secondary)" />
                          <span>Googleマップ済</span>
                        </>
                      )}
                      {review.status === 'posted' && (
                        <>
                          <CheckCircle2 size={12} color="var(--success)" />
                          <span>すべて投稿済</span>
                        </>
                      )}
                    </span>
                  </div>

                  {review.photo_thumbs && review.photo_thumbs.some(path => thumbUrls[path]) && (
                    <div className={styles.cardThumbs}>
                      {review.photo_thumbs.map(path =>
                        thumbUrls[path] ? (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img
                            key={path}
                            src={thumbUrls[path]}
                            alt="料理の写真"
                            className={styles.cardThumbImg}
                            loading="lazy"
                          />
                        ) : null
                      )}
                    </div>
                  )}

                  {review.raw_memo && (
                    <div className={styles.cardMemo}>
                      <strong>体験メモ：</strong>
                      <p>{review.raw_memo}</p>
                    </div>
                  )}

                  {review.generated_review ? (() => {
                    // Prefer the structured columns; fall back to regex parsing for old records
                    const { title, comment } = getReviewParts(review);
                    const titleKey = `${review.id}-title`;
                    const commentKey = `${review.id}-comment`;
                    const editingTitle = editingReviewKey === titleKey;
                    const editingComment = editingReviewKey === commentKey;
                    return (
                      <div className={styles.cardReviewText}>
                        {title && (
                          <div className={styles.reviewSection}>
                            <div className={styles.reviewSectionHeader}>
                              <strong>
                                タイトル (<span className={title.length > TABELOG_TITLE_MAX ? styles.charCountOver : ''}>{title.length}文字</span>)
                                {title.length > TABELOG_TITLE_MAX && (
                                  <span className={styles.charLimitWarning}>食べログの上限{TABELOG_TITLE_MAX}文字を超えています</span>
                                )}
                              </strong>
                              {!editingTitle && (
                                <div className={styles.reviewSectionActions}>
                                  <button
                                    onClick={() => handleStartEditReview(review, 'title')}
                                    className={`${styles.miniCopyBtn}`}
                                    title="タイトルを編集"
                                  >
                                    <Edit2 size={11} />
                                    <span>編集</span>
                                  </button>
                                  <button
                                    onClick={() => handleCopyToClipboard(title, titleKey)}
                                    className={`${styles.miniCopyBtn}`}
                                    title="タイトルをコピー"
                                  >
                                    {copiedId === titleKey ? (
                                      <>
                                        <Check size={11} />
                                        <span>コピー完了</span>
                                      </>
                                    ) : (
                                      <>
                                        <Clipboard size={11} />
                                        <span>コピー</span>
                                      </>
                                    )}
                                  </button>
                                </div>
                              )}
                            </div>
                            {editingTitle ? (
                              <div className={styles.reviewEditForm}>
                                <input
                                  type="text"
                                  value={editReviewValue}
                                  onChange={(e) => setEditReviewValue(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleSaveReview(review, 'title');
                                    if (e.key === 'Escape') handleCancelEditReview();
                                  }}
                                  className={styles.reviewEditInput}
                                  autoFocus
                                  disabled={savingReviewKey === titleKey}
                                />
                                <div className={styles.reviewEditActions}>
                                  <button
                                    onClick={() => handleSaveReview(review, 'title')}
                                    className="btn btn-primary btn-sm"
                                    disabled={savingReviewKey === titleKey || !editReviewValue.trim()}
                                  >
                                    {savingReviewKey === titleKey ? <Loader2 className={styles.spinner} size={12} /> : <Check size={12} />}
                                    <span>保存</span>
                                  </button>
                                  <button
                                    onClick={handleCancelEditReview}
                                    className="btn btn-secondary btn-sm"
                                    disabled={savingReviewKey === titleKey}
                                  >
                                    <X size={12} />
                                    <span>キャンセル</span>
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <p className={styles.reviewTitleContent}>{title}</p>
                            )}
                          </div>
                        )}
                        {comment && (
                          <div className={styles.reviewSection} style={{ marginTop: '0.75rem' }}>
                            <div className={styles.reviewSectionHeader}>
                              <strong>
                                コメント (<span className={comment.length > COMMENT_TARGET_MAX ? styles.charCountCaution : ''}>{comment.length}文字</span>)
                                {comment.length > COMMENT_TARGET_MAX && (
                                  <span className={styles.charTargetNote}>目安の{COMMENT_TARGET_MAX}文字を超えています</span>
                                )}
                              </strong>
                              {!editingComment && (
                                <div className={styles.reviewSectionActions}>
                                  <button
                                    onClick={() => handleStartEditReview(review, 'comment')}
                                    className={`${styles.miniCopyBtn}`}
                                    title="本文を編集"
                                  >
                                    <Edit2 size={11} />
                                    <span>編集</span>
                                  </button>
                                  <button
                                    onClick={() => handleCopyToClipboard(comment, commentKey)}
                                    className={`${styles.miniCopyBtn}`}
                                    title="本文をコピー"
                                  >
                                    {copiedId === commentKey ? (
                                      <>
                                        <Check size={11} />
                                        <span>コピー完了</span>
                                      </>
                                    ) : (
                                      <>
                                        <Clipboard size={11} />
                                        <span>コピー</span>
                                      </>
                                    )}
                                  </button>
                                </div>
                              )}
                            </div>
                            {editingComment ? (
                              <div className={styles.reviewEditForm}>
                                <textarea
                                  value={editReviewValue}
                                  onChange={(e) => setEditReviewValue(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Escape') handleCancelEditReview();
                                  }}
                                  rows={5}
                                  className={styles.reviewEditTextarea}
                                  autoFocus
                                  disabled={savingReviewKey === commentKey}
                                />
                                <div className={styles.reviewEditFooter}>
                                  <span className={editReviewValue.length > COMMENT_TARGET_MAX ? styles.charCountCaution : styles.reviewEditCount}>
                                    {editReviewValue.length}文字
                                  </span>
                                  <div className={styles.reviewEditActions}>
                                    <button
                                      onClick={() => handleSaveReview(review, 'comment')}
                                      className="btn btn-primary btn-sm"
                                      disabled={savingReviewKey === commentKey || !editReviewValue.trim()}
                                    >
                                      {savingReviewKey === commentKey ? <Loader2 className={styles.spinner} size={12} /> : <Check size={12} />}
                                      <span>保存</span>
                                    </button>
                                    <button
                                      onClick={handleCancelEditReview}
                                      className="btn btn-secondary btn-sm"
                                      disabled={savingReviewKey === commentKey}
                                    >
                                      <X size={12} />
                                      <span>キャンセル</span>
                                    </button>
                                  </div>
                                </div>
                              </div>
                            ) : (
                              <p className={styles.reviewParagraph}>{comment}</p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })() : review.status === 'processing' ? (
                    <div className={styles.generatingPlaceholder}>
                      <Loader2 className={styles.spinner} size={18} />
                      <span>AIが画像を解析し、ガイドライン適合レビューを検閲・生成しています...</span>
                    </div>
                  ) : (
                    <div className={styles.generatingPlaceholder} style={{ color: 'var(--danger)' }}>
                      生成に失敗しました。このカードを削除してやり直してください。
                    </div>
                  )}

                  {/* Rewrite input drawer */}
                  {openRewriteId === review.id && (
                    <div className={styles.rewriteContainer}>
                      <div className={styles.rewriteHeader}>
                        <Sparkles size={14} color="var(--primary)" />
                        <span className={styles.rewriteHeaderText}>AIレビュー修正</span>
                      </div>
                      {rewriteError && <div className={styles.rewriteError}>{rewriteError}</div>}
                      <div className={styles.rewriteInputWrapper}>
                        <textarea
                          placeholder="例：料理の味をもっと詳しく書いて / 文字数をもう少し短くして / 少しカジュアルなトーンにして"
                          value={rewriteInstruction}
                          onChange={(e) => setRewriteInstruction(e.target.value)}
                          disabled={rewritingId === review.id}
                          className={styles.rewriteTextarea}
                          rows={2}
                        />
                        <div className={styles.rewriteFormActions}>
                          <button
                            type="button"
                            onClick={() => {
                              setOpenRewriteId(null);
                              setRewriteInstruction('');
                              setRewriteError(null);
                            }}
                            className="btn btn-secondary btn-sm"
                            disabled={rewritingId === review.id}
                          >
                            キャンセル
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRewrite(review.id)}
                            className="btn btn-primary btn-sm"
                            disabled={rewritingId === review.id || !rewriteInstruction.trim()}
                          >
                            {rewritingId === review.id ? (
                              <>
                                <Loader2 className={styles.spinner} size={12} />
                                <span>実行中...</span>
                              </>
                            ) : (
                              <>
                                <Sparkles size={12} />
                                <span>実行</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className={styles.cardActions}>
                    {review.generated_review && (
                      <div className={styles.postedButtonsGroup}>
                        {(() => {
                          const tabelogDone = review.status === 'posted_tabelog' || review.status === 'posted';
                          const googleDone = review.status === 'posted_google' || review.status === 'posted';
                          const postComment = getReviewParts(review).comment;
                          return (
                            <>
                              {review.place_id && postComment && (
                                // ワンタップ投稿: コメントをコピーしつつ、Googleマップの
                                // この店舗のクチコミ投稿画面を直接開く（place_id利用）。
                                // コピーは同期APIを優先し、成功した場合のみアンカーの
                                // ネイティブ遷移に任せる。同期コピーが失敗した場合は
                                // 遷移を止めて非同期APIで再試行し、コピーできてから開く
                                // （未コピーのまま投稿画面だけが開く事故を防ぐ）
                                <a
                                  href={`https://search.google.com/local/writereview?placeid=${encodeURIComponent(review.place_id)}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={async (e) => {
                                    const url = e.currentTarget.href;
                                    if (copyTextSync(postComment)) {
                                      setCopiedId(`${review.id}-gpost`);
                                      setTimeout(() => setCopiedId(null), 2000);
                                      return; // ネイティブ遷移に任せる
                                    }
                                    e.preventDefault();
                                    try {
                                      await navigator.clipboard.writeText(postComment);
                                      setCopiedId(`${review.id}-gpost`);
                                      setTimeout(() => setCopiedId(null), 2000);
                                      const opened = window.open(url, '_blank', 'noopener,noreferrer');
                                      if (!opened) window.location.assign(url); // ポップアップブロック時は同タブで開く
                                    } catch {
                                      alert('コメントのコピーに失敗しました。コメント欄の「コピー」ボタンでコピーしてから、もう一度お試しください。');
                                    }
                                  }}
                                  className={`${styles.platformPostBtn} ${styles.gPostBtn} btn btn-secondary`}
                                  title="コメントをコピーして、Googleマップのこの店のクチコミ投稿画面を開く"
                                >
                                  <ExternalLink size={14} />
                                  <span>{copiedId === `${review.id}-gpost` ? 'コメントをコピーして開きました' : 'Googleマップに投稿'}</span>
                                </a>
                              )}
                              <button
                                onClick={() => handleTogglePlatformPosted(review.id, 'tabelog')}
                                className={`${styles.platformPostBtn} btn btn-secondary ${tabelogDone ? styles.platformPostBtnDone : ''}`}
                                title={tabelogDone ? '食べログへの投稿完了を取り消す' : '食べログへの投稿を完了にする'}
                              >
                                <CheckCircle2 size={14} color={tabelogDone ? 'var(--success)' : 'var(--primary)'} />
                                <span>{tabelogDone ? '食べログ済' : '食べログ完了'}</span>
                              </button>
                              <button
                                onClick={() => handleTogglePlatformPosted(review.id, 'google')}
                                className={`${styles.platformPostBtn} btn btn-secondary ${googleDone ? styles.platformPostBtnDone : ''}`}
                                title={googleDone ? 'Googleマップへの投稿完了を取り消す' : 'Googleマップへの投稿を完了にする'}
                              >
                                <CheckCircle2 size={14} color={googleDone ? 'var(--success)' : 'var(--secondary)'} />
                                <span>{googleDone ? 'Googleマップ済' : 'Googleマップ完了'}</span>
                              </button>
                            </>
                          );
                        })()}
                        {review.status !== 'processing' && (
                          <button
                            onClick={() => {
                              if (openRewriteId === review.id) {
                                setOpenRewriteId(null);
                                setRewriteInstruction('');
                                setRewriteError(null);
                              } else {
                                setOpenRewriteId(review.id);
                                setRewriteInstruction('');
                                setRewriteError(null);
                              }
                            }}
                            className={`${styles.platformPostBtn} ${styles.rewriteBtn} btn btn-secondary ${openRewriteId === review.id ? styles.activeRewriteToggle : ''}`}
                            title="AIでレビューを修正・再生成"
                          >
                            <RefreshCw size={14} className={rewritingId === review.id ? styles.spinIcon : ''} color="var(--primary)" />
                            <span>リライト</span>
                          </button>
                        )}
                      </div>
                    )}

                    <button
                      onClick={() => handleDeleteReview(review.id)}
                      className={`${styles.deleteBtn}`}
                      title="削除する"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>

                </div>
              ))
            )}
          </div>
        </section>

      </div>
    </div>
  );
}
