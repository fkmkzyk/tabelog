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
  X
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
  const [user, setUser] = useState<any>(null);
  const [loadingUser, setLoadingUser] = useState(true);

  // Form states
  const [shopName, setShopName] = useState('');
  const [rating, setRating] = useState(3.0);
  const [rawMemo, setRawMemo] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [photosBase64, setPhotosBase64] = useState<string[]>([]);
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

  // Client-side image resizing and base64 encoding (multiple files)
  const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setFormError(null);
    const newFiles = Array.from(files);

    if (photos.length + newFiles.length > 3) {
      setFormError('画像は最大3枚までアップロードできます');
      return;
    }

    const resizePromises = newFiles.map(file => {
      return new Promise<string>((resolve, reject) => {
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
              reject(new Error('Canvasコンテキストの取得に失敗しました'));
              return;
            }
            ctx.drawImage(img, 0, 0, width, height);
            
            const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
            resolve(dataUrl);
          };
          img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
        };
        reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました'));
      });
    });

    try {
      const base64s = await Promise.all(resizePromises);
      setPhotos(prev => [...prev, ...newFiles]);
      setPhotosBase64(prev => [...prev, ...base64s]);
    } catch (err: any) {
      setFormError(err.message || '画像の処理中にエラーが発生しました');
    }

    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleRemovePhoto = (index: number) => {
    setPhotos(prev => prev.filter((_, i) => i !== index));
    setPhotosBase64(prev => prev.filter((_, i) => i !== index));
  };

  // Submit and trigger API route
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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

      // Copy local variables to send in fetch
      const payloadImages = [...photosBase64];

      // Clear input fields during processing
      setShopName('');
      setRating(3.0);
      setRawMemo('');
      setPhotos([]);
      setPhotosBase64([]);
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
          images_base64: payloadImages,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        // If server failed, clean up the processing record in DB
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
  const handleCopyToClipboard = (text: string, copyKey: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(copyKey);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  // Helper to render fractional stars (0.2 step)
  const renderStars = (val: number, size: number = 28) => {
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
                          {renderStars(review.rating, 14)}
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

                  {review.generated_review ? (() => {
                    const { title, comment } = parseReview(review.generated_review);
                    return (
                      <div className={styles.cardReviewText}>
                        {title && (
                          <div className={styles.reviewSection}>
                            <div className={styles.reviewSectionHeader}>
                              <strong>タイトル</strong>
                              <button
                                onClick={() => handleCopyToClipboard(title, `${review.id}-title`)}
                                className={`${styles.miniCopyBtn}`}
                                title="タイトルをコピー"
                              >
                                {copiedId === `${review.id}-title` ? (
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
                            <p className={styles.reviewTitleContent}>{title}</p>
                          </div>
                        )}
                        {comment && (
                          <div className={styles.reviewSection} style={{ marginTop: '0.75rem' }}>
                            <div className={styles.reviewSectionHeader}>
                              <strong>コメント</strong>
                              <button
                                onClick={() => handleCopyToClipboard(comment, `${review.id}-comment`)}
                                className={`${styles.miniCopyBtn}`}
                                title="本文をコピー"
                              >
                                {copiedId === `${review.id}-comment` ? (
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
                            <p className={styles.reviewParagraph}>{comment}</p>
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

                  <div className={styles.cardActions}>
                    {review.generated_review && review.status === 'draft' && (
                      <button
                        onClick={() => handleMarkAsPosted(review.id)}
                        className="btn btn-secondary"
                        style={{ flex: 1 }}
                        title="投稿完了にする"
                      >
                        <CheckCircle2 size={16} color="var(--success)" />
                        <span>投稿完了にする</span>
                      </button>
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
