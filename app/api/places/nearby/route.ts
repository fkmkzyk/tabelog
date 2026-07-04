import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { searchNearbyRestaurants } from '@/lib/places';

export async function POST(request: Request) {
  try {
    // 1. Verify Authentication (protects the server-side Places API key from abuse)
    await verifyAuth(request);

    // 2. Parse and validate coordinates
    const body = await request.json();
    const { lat, lng } = body;

    if (
      typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
      typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180
    ) {
      return NextResponse.json({ error: 'Invalid coordinates' }, { status: 400 });
    }

    // 3. Search nearby food places
    const candidates = await searchNearbyRestaurants(lat, lng);

    return NextResponse.json({ candidates });

  } catch (error: unknown) {
    const err = error as { status?: number; message?: string };
    const status = err.status || 500;
    const message = err.message || 'Internal Server Error';
    if (status >= 500) console.error('Error searching nearby places:', error);
    return NextResponse.json({ error: message }, { status });
  }
}
