'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import styles from './dashboard.module.css';
import {
  UtensilsCrossed,
  LogOut,
  Camera,
  Star,
  Sparkles,
  Clipboard,
  Check,
  Send,
  Loader2,
  Trash2,
  CheckCircle2,
  PlusCircle,
  FileText,
  Clock
} from 'lucide-react';

interface Review {
  id: string;
  user_id: string;
  shop_name: string;
  rating: number;
  raw_memo: string | null;
  generated_review: string | null;
  status: 'processing' | 'draft' | 'posted';
  created_at: string;
}

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [loadingUser, setLoadingUser] = useState(true);

  // Form states
  const [shopName, setShopName] = useState('');
  const [rating, setRating] = useState(3.0);
  const [rawMemo, setRawMemo] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // List states
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loadingReviews, setLoadingReviews] = useState(false);
  const [filterTab, setFilterTab] = useState<'all' | 'draft' | 'posted'>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);

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
  }, [router]);

  // Fetch reviews list
  const fetchReviews = async (userId: string) => {
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
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingReviews(false);
    }
  };

  // Logout handler
  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push('/login');
  };

  // Client-side image resizing and base64 encoding
  const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setPhoto(file);
    setFormError(null);

    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target?.result as string;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 1200;
        const MAX_HEIGHT = 1200;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height = Math.round((height * MAX_WIDTH) / width);
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width = Math.round((width * MAX_HEIGHT) / height);
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          setFormError('画像のリサイズに失敗しました（Canvasコンテキスト取得エラー）');
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        
        // Compress JPEG to 85% quality
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        setPhotoBase64(dataUrl);
      };
      img.onerror = () => {
        setFormError('画像の読み込みに失敗しました');
      };
    };
    reader.onerror = () => {
      setFormError('ファイルの読み込みに失敗しました');
    };
  };

  // Submit and trigger API route
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shopName) {
      setFormError('店舗名を入力してください');
      return;
    }
    if (!photoBase64) {
      setFormError('写真をアップロードしてください');
      return;
    }

    setGenerating(true);
    setFormError(null);

    try {
      // 1. Create a draft record in database
      const { data: insertedReview, error: insertError } = await supabase
        .from('tabelog_reviews')
        .insert({
          user_id: user.id,
          shop_name: shopName,
          rating: rating,
          raw_memo: rawMemo || null,
          status: 'processing',
        })
        .select()
        .single();

      if (insertError) {
        throw new Error(`DB保存エラー: ${insertError.message}`);
      }

      // Refresh list immediately so user sees 'processing' state
      setReviews(prev => [insertedReview, ...prev]);

      // Clear input fields during processing
      setShopName('');
      setRating(3.0);
      setRawMemo('');
      setPhoto(null);
      setPhotoBase64(null);
      if (fileInputRef.current) fileInputRef.current.value = '';

      // 2. Fetch session and tokens
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      // 3. Request review generation from Next.js server API
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          review_id: insertedReview.id,
          shop_name: insertedReview.shop_name,
          rating: insertedReview.rating,
          raw_memo: insertedReview.raw_memo,
          image_base64: photoBase64,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        // If server failed, update status to failed in state/DB or just throw
        await supabase
          .from('tabelog_reviews')
          .delete()
          .eq('id', insertedReview.id);
        throw new Error(result.error || 'レビュー生成に失敗しました');
      }

      // 4. Reload lists to get final review
      fetchReviews(user.id);

    } catch (err: any) {
      setFormError(err.message || '予期せぬエラーが発生しました');
      // Re-fetch list to sync states
      if (user) fetchReviews(user.id);
    } finally {
      setGenerating(false);
    }
  };

  // Mark a draft as posted
  const handleMarkAsPosted = async (reviewId: string) => {
    try {
      const { error } = await supabase
        .from('tabelog_reviews')
        .update({ status: 'posted' })
        .eq('id', reviewId);

      if (error) throw error;

      // Update state locally
      setReviews(prev =>
        prev.map(r => (r.id === reviewId ? { ...r, status: 'posted' } : r))
      );
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  };

  // Delete a review card
  const handleDeleteReview = async (reviewId: string) => {
    if (!confirm('この下書きを削除してもよろしいですか？')) return;
    
    try {
      const { error } = await supabase
        .from('tabelog_reviews')
        .delete()
        .eq('id', reviewId);

      if (error) throw error;

      setReviews(prev => prev.filter(r => r.id !== reviewId));
    } catch (err) {
      console.error('Failed to delete review:', err);
    }
  };

  // Copy to clipboard helper
  const handleCopyToClipboard = (text: string, reviewId: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(reviewId);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  // Filter reviews
  const filteredReviews = reviews.filter(r => {
    if (filterTab === 'all') return true;
    return r.status === filterTab;
  });

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
          <span className={styles.userEmail}>{user.email}</span>
          <button onClick={handleLogout} className="btn btn-secondary" title="ログアウト">
            <LogOut size={16} />
            <span>ログアウト</span>
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
                  placeholder="例：銀座 うかい亭"
                  className="form-control"
                  value={shopName}
                  onChange={(e) => setShopName(e.target.value)}
                  disabled={generating}
                />
              </div>

              <div className="form-group">
                <label className="form-label">評価（5段階）<span className={styles.required}>*</span></label>
                <div className={styles.starRatingContainer}>
                  {[1, 2, 3, 4, 5].map((star) => (
                    <button
                      key={star}
                      type="button"
                      className={styles.starButton}
                      onClick={() => setRating(star)}
                      disabled={generating}
                    >
                      <Star
                        size={28}
                        fill={star <= rating ? 'var(--secondary)' : 'none'}
                        color={star <= rating ? 'var(--secondary)' : 'var(--text-muted)'}
                        className={styles.starIcon}
                      />
                    </button>
                  ))}
                  <span className={styles.ratingValue}>{rating.toFixed(1)}</span>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">写真 <span className={styles.required}>*</span></label>
                <div className={styles.photoUploadArea}>
                  <input
                    type="file"
                    accept="image/*"
                    ref={fileInputRef}
                    className={styles.fileInput}
                    onChange={handlePhotoChange}
                    id="photo-upload-input"
                    disabled={generating}
                  />
                  <label htmlFor="photo-upload-input" className={styles.photoUploadLabel}>
                    {photoBase64 ? (
                      <div className={styles.photoPreviewWrapper}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={photoBase64} alt="Upload preview" className={styles.photoPreview} />
                        <span className={styles.photoChangeHint}>写真を変更</span>
                      </div>
                    ) : (
                      <div className={styles.photoUploadPlaceholder}>
                        <Camera size={36} className={styles.uploadIcon} />
                        <span className={styles.uploadText}>料理・店舗の写真を撮影 / 選択</span>
                        <span className={styles.uploadSubtext}>※ブラウザ側で1200pxに自動リサイズされます</span>
                      </div>
                    )}
                  </label>
                </div>
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
                disabled={generating || !shopName || !photoBase64}
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
              すべて ({reviews.length})
            </button>
            <button
              onClick={() => setFilterTab('draft')}
              className={`${styles.tabBtn} ${filterTab === 'draft' ? styles.activeTab : ''}`}
            >
              未投稿 ({reviews.filter(r => r.status === 'draft').length})
            </button>
            <button
              onClick={() => setFilterTab('posted')}
              className={`${styles.tabBtn} ${filterTab === 'posted' ? styles.activeTab : ''}`}
            >
              投稿完了 ({reviews.filter(r => r.status === 'posted').length})
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
                      <h3 className={styles.cardShopName}>{review.shop_name}</h3>
                      <div className={styles.cardMeta}>
                        <div className={styles.cardStars}>
                          {Array.from({ length: 5 }).map((_, i) => (
                            <Star
                              key={i}
                              size={14}
                              fill={i < review.rating ? 'var(--secondary)' : 'none'}
                              color={i < review.rating ? 'var(--secondary)' : 'var(--text-muted)'}
                            />
                          ))}
                        </div>
                        <span className={styles.cardDate}>
                          {new Date(review.created_at).toLocaleDateString('ja-JP', {
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit'
                          })}
                        </span>
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
                      {review.status === 'posted' && (
                        <>
                          <CheckCircle2 size={12} />
                          <span>投稿完了</span>
                        </>
                      )}
                    </span>
                  </div>

                  {review.raw_memo && (
                    <div className={styles.cardMemo}>
                      <strong>体験メモ：</strong>
                      <p>{review.raw_memo}</p>
                    </div>
                  )}

                  {review.generated_review ? (
                    <div className={styles.cardReviewText}>
                      <strong>生成されたレビュー：</strong>
                      <p className={styles.reviewParagraph}>{review.generated_review}</p>
                    </div>
                  ) : review.status === 'processing' ? (
                    <div className={styles.generatingPlaceholder}>
                      <Loader2 className={styles.spinner} size={18} />
                      <span>AIが画像を解析し、ガイドライン適合レビューを検閲・生成しています...</span>
                    </div>
                  ) : (
                    <div className={styles.generatingPlaceholder} style={{ color: 'var(--danger)' }}>
                      生成に失敗しました。このカードを削除してやり直してください。
                    </div>
                  )}

                  <div className={styles.cardActions}>
                    {review.generated_review && (
                      <>
                        <button
                          onClick={() => handleCopyToClipboard(review.generated_review || '', review.id)}
                          className="btn btn-primary"
                          style={{ flex: 1 }}
                        >
                          {copiedId === review.id ? (
                            <>
                              <Check size={16} />
                              <span>コピー完了!</span>
                            </>
                          ) : (
                            <>
                              <Clipboard size={16} />
                              <span>レビューをコピー</span>
                            </>
                          )}
                        </button>

                        {review.status === 'draft' && (
                          <button
                            onClick={() => handleMarkAsPosted(review.id)}
                            className="btn btn-secondary"
                            title="投稿完了にする"
                          >
                            <CheckCircle2 size={16} color="var(--success)" />
                            <span>投稿完了</span>
                          </button>
                        )}
                      </>
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
