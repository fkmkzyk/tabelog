import type { SupabaseClient } from '@supabase/supabase-js';
import { describeVisitDateTime } from './gemini';

/**
 * 同じ店舗（place_id）への過去の訪問を検索し、AIプロンプト用の再訪情報を
 * 日本語で組み立てるヘルパー。過去の訪問がない・place_id不明ならnull。
 * 例: 「この店への2回目の訪問（前回の評価: 3.6、前回の訪問時期: 6月中旬）」
 * 具体的な日付はレビュー本文にコピーされやすいため、あえて渡さない。
 */
export async function describeRevisit(
  client: SupabaseClient,
  userId: string,
  placeId: string | null,
  excludeReviewId: string,
): Promise<string | null> {
  if (!placeId) return null;

  try {
    const { data, count, error } = await client
      .from('tabelog_reviews')
      .select('rating, visit_date', { count: 'exact' })
      .eq('user_id', userId)
      .eq('place_id', placeId)
      .neq('id', excludeReviewId)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error || !count || count === 0) return null;

    let desc = `この店への${count + 1}回目の訪問`;
    const prev = (data?.[0] ?? null) as unknown as { rating: number; visit_date: string | null } | null;
    if (prev) {
      desc += `（前回の評価: ${Number(prev.rating).toFixed(1)}`;
      const prevPeriod = describeVisitDateTime(prev.visit_date, null);
      if (prevPeriod) desc += `、前回の訪問時期: ${prevPeriod}`;
      desc += '）';
    }
    return desc;
  } catch {
    return null;
  }
}
