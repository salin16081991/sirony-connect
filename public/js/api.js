/** Thin fetch wrapper. `no-store` everywhere: API responses carry personal
 *  data and must never be persisted by the browser or the service worker. */
async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    cache: 'no-store',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  let payload = null;
  if (res.status !== 204) {
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const error = new Error(payload?.error ?? `request_failed_${res.status}`);
    error.status = res.status;
    error.code = payload?.error;
    throw error;
  }
  return payload;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
};

/** Human-readable messages. Anything unmapped falls back to a neutral string
 *  rather than leaking a raw server code into the UI. */
const MESSAGES = {
  adults_only: 'Sirony Connect is for adults aged 18 and over.',
  invalid_credentials: 'That email and password combination did not work.',
  registration_failed: 'That account could not be created. Try signing in instead.',
  invalid_date_of_birth: 'Please enter a valid date of birth.',
  authentication_required: 'Please sign in to continue.',
  age_range_inverted: 'The maximum age must be at least the minimum age.',
  not_found: 'That is no longer available.',
  cannot_like_self: 'You cannot connect with your own profile.',
  match_expired: 'This match expired before anyone opened it.',
  not_your_opening_move: 'The opening move belongs to the other person.',
  already_extended: 'This match has already been extended once.',
  already_open: 'This conversation is already open.',
  nothing_to_undo: 'There is nothing to undo.',
  video_must_be_a_link: 'Upload video to YouTube and paste the link instead.',
  invalid_youtube_url: 'That does not look like a YouTube link.',
  photo_or_link_not_both: 'Choose either a photo or a link, not both.',
  file_too_large: 'That file is too large. Photos up to 8MB.',
  unsupported_type: 'Only JPEG, PNG and WebP photos are supported.',
  video_url_required: 'Reels need a YouTube link.',
};

export function messageFor(error) {
  if (error?.status === 429) return 'Too many attempts. Please wait a moment.';
  return MESSAGES[error?.code] ?? 'Something went wrong. Please try again.';
}
