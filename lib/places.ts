const PLACES_SEARCH_NEARBY_URL = 'https://places.googleapis.com/v1/places:searchNearby';

// Search radius around the photo's GPS position (meters)
const SEARCH_RADIUS_METERS = 100;
// Food-related place types (Places API Table A)
const FOOD_PLACE_TYPES = ['restaurant', 'cafe', 'bar', 'bakery', 'meal_takeaway'];

export interface PlaceCandidate {
  placeId: string;
  name: string;
  address: string;
  primaryType: string | null;
  lat: number;
  lng: number;
  distanceMeters: number;
}

/**
 * Great-circle distance between two coordinates in meters (haversine formula).
 */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371000; // Earth radius in meters
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface NearbySearchPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  primaryTypeDisplayName?: { text?: string };
  location?: { latitude?: number; longitude?: number };
}

/**
 * Search food places near the given coordinates via Google Places API (New).
 * The field mask is limited to Pro-SKU fields on purpose: requesting
 * Enterprise fields (phone, opening hours, rating, ...) would drop the free
 * monthly quota from 5,000 to 1,000 calls.
 * Throws a structured error if the API key is missing or the call fails.
 */
export async function searchNearbyRestaurants(lat: number, lng: number): Promise<PlaceCandidate[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw { message: 'Google Places API is not configured on the server.', status: 500 };
  }

  const response = await fetch(PLACES_SEARCH_NEARBY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask':
        'places.id,places.displayName,places.formattedAddress,places.primaryTypeDisplayName,places.location',
    },
    body: JSON.stringify({
      includedTypes: FOOD_PLACE_TYPES,
      maxResultCount: 5,
      rankPreference: 'DISTANCE',
      languageCode: 'ja',
      locationRestriction: {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius: SEARCH_RADIUS_METERS,
        },
      },
    }),
  });

  if (!response.ok) {
    console.error('Places API error:', response.status, await response.text());
    throw { message: '店舗候補の検索に失敗しました', status: 502 };
  }

  const data = (await response.json()) as { places?: NearbySearchPlace[] };

  return (data.places || [])
    .filter(p => p.id && p.displayName?.text && p.location?.latitude != null && p.location?.longitude != null)
    .map(p => ({
      placeId: p.id as string,
      name: p.displayName!.text as string,
      address: p.formattedAddress || '',
      primaryType: p.primaryTypeDisplayName?.text || null,
      lat: p.location!.latitude as number,
      lng: p.location!.longitude as number,
      distanceMeters: haversineMeters(lat, lng, p.location!.latitude as number, p.location!.longitude as number),
    }));
}
