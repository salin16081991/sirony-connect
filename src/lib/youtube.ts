/**
 * Accepts the URL shapes YouTube actually hands people — watch links, shorts,
 * youtu.be, and share URLs with tracking parameters — and reduces them to a
 * bare video id.
 *
 * Everything else is rejected. This is the only external identifier the
 * platform stores for a reel, so it must not become a free-text field that
 * can point anywhere.
 */
const ID = /^[A-Za-z0-9_-]{11}$/;

const HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

export interface ParsedVideo {
  videoId: string;
  /** Canonical form, stored and shown. Tracking parameters are dropped. */
  canonicalUrl: string;
}

export function parseYouTubeUrl(input: string): ParsedVideo | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }

  // http would downgrade the user's connection when they follow the link.
  if (url.protocol !== 'https:') return null;
  if (!HOSTS.has(url.hostname.toLowerCase())) return null;

  let candidate: string | null = null;

  if (url.hostname.toLowerCase().endsWith('youtu.be')) {
    candidate = url.pathname.slice(1).split('/')[0] ?? null;
  } else if (url.pathname === '/watch') {
    candidate = url.searchParams.get('v');
  } else {
    const match = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
    candidate = match?.[1] ?? null;
  }

  if (!candidate || !ID.test(candidate)) return null;

  return {
    videoId: candidate,
    canonicalUrl: `https://www.youtube.com/watch?v=${candidate}`,
  };
}

/** Thumbnail served by YouTube. Only used if the client opts to load it. */
export function thumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}
