import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q') || '';

    if (!query) {
      return NextResponse.redirect('https://tabelog.com', 302);
    }

    // Direct search query URL on Tabelog
    const searchUrl = `https://tabelog.com/rst/rstsearch/?sk=${encodeURIComponent(query)}`;

    // Return a 302 redirect. On iOS, a server-side redirect from a non-associated
    // domain forces the page to open in the browser (Safari) instead of launching the native app.
    return NextResponse.redirect(searchUrl, 302);
  } catch (error) {
    console.error('Error redirecting to Tabelog search:', error);
    return NextResponse.redirect('https://tabelog.com', 302);
  }
}
