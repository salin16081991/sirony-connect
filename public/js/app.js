import { api, messageFor } from './api.js';
import { card, chipGroup, confirmAction, el, field, haptic, mount, seen, sheet, showSkeleton, toast } from './ui.js';
import { createDeck } from './swipe.js';

/* ------------------------------------------------------------- constants -- */

const MODES = [
  ['marriage', 'Marriage'],
  ['long_term', 'Long-term'],
  ['casual_dating', 'Casual dating'],
  ['fun_hangout', 'Fun & hangout'],
  ['hookup', 'Consensual hookup'],
  ['friends', 'Friends'],
  ['activity_partners', 'Activity partners'],
  ['networking', 'Networking'],
];
const MODE_LABEL = Object.fromEntries(MODES);

const KINDS = [
  ['dating', 'Dating'],
  ['friends', 'Friends'],
  ['activities', 'Activities'],
  ['networking', 'Networking'],
];

const VISIBILITIES = [
  ['invisible', 'Invisible — nobody can find this profile'],
  ['audiences', 'Selected audiences only'],
  ['clubs_events', 'Clubs and events only'],
  ['discoverable', 'Discoverable — can appear in swiping'],
];

const REPORT_CATEGORIES = [
  ['harassment', 'Harassment'],
  ['threats', 'Threats'],
  ['scam', 'Scam or fraud'],
  ['impersonation', 'Impersonation'],
  ['non_consensual_imagery', 'Non-consensual imagery'],
  ['underage', 'Appears to be under 18'],
  ['other', 'Something else'],
];

const state = { user: null, profiles: [] };

/* ----------------------------------------------------------------- icons -- */

const svg = (paths, viewBox = '0 0 24 24') =>
  el('span', {
    html: `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="2.2"
      stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`,
  });

const ICON = {
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  heart: '<path d="M12 20s-7-4.4-7-9.3A4 4 0 0 1 12 7.6 4 4 0 0 1 19 10.7c0 4.9-7 9.3-7 9.3Z"/>',
  rewind: '<path d="M3 8h11a5.5 5.5 0 1 1 0 11H8"/><path d="m6.5 4.5-3.5 3.5 3.5 3.5"/>',
  star: '<path d="m12 4 2.3 4.9 5.2.7-3.8 3.7.9 5.3-4.6-2.6-4.6 2.6.9-5.3L4.5 9.6l5.2-.7Z"/>',
};

/** Deterministic colour from an id, so a photo-less card still looks intentional. */
function hueFor(id = '') {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 360;
  return hash;
}

function gradientFor(id) {
  const h = hueFor(id);
  return `linear-gradient(150deg, hsl(${h} 62% 42%), hsl(${(h + 48) % 360} 68% 26%))`;
}

function avatar(profileId, name, size = 52) {
  return el('div', {
    class: 'avatar',
    style: `background:${gradientFor(profileId)};width:${size}px;height:${size}px;font-size:${size / 2.6}px`,
    text: (name ?? '?').trim().charAt(0).toUpperCase(),
  });
}

/* ------------------------------------------------------------ auth screen -- */

function authView() {
  let mode = 'login';
  const wrap = el('div', { class: 'view', style: 'display:grid;gap:.85rem' });

  const render = () => {
    const isLogin = mode === 'login';
    const email = el('input', { type: 'email', required: true, autocomplete: 'email' });
    const password = el('input', {
      type: 'password',
      required: true,
      minlength: '12',
      autocomplete: isLogin ? 'current-password' : 'new-password',
    });
    const dob = el('input', { type: 'date', required: true });
    const error = el('p', { class: 'error-text', hidden: true });
    const submit = el('button', {
      class: 'btn btn-block',
      type: 'submit',
      text: isLogin ? 'Sign in' : 'Create account',
    });

    const form = el('form', {
      onSubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        submit.disabled = true;
        try {
          const path = isLogin ? '/api/auth/login' : '/api/auth/register';
          const payload = isLogin
            ? { email: email.value, password: password.value }
            : { email: email.value, password: password.value, dateOfBirth: dob.value };
          await api.post(path, payload);
          await boot();
          location.hash = isLogin ? '#/discover' : '#/welcome';
          route();
        } catch (err) {
          error.textContent = messageFor(err);
          error.hidden = false;
        } finally {
          submit.disabled = false;
        }
      },
    }, [
      field('Email', email),
      field('Password', password, isLogin ? undefined : 'At least 12 characters.'),
      isLogin ? null : field('Date of birth', dob, 'Adults only. Never shown on your profile.'),
      error,
      submit,
    ]);

    wrap.replaceChildren(
      el('div', { style: 'padding:1.5rem 0 .5rem' }, [
        el('h1', { text: isLogin ? 'Welcome back' : 'Find your people' , style: 'font-size:1.9rem'}),
        el('p', {
          class: 'muted',
          style: 'margin:.4rem 0 0',
          text: isLogin
            ? 'Sign in to see who is waiting.'
            : 'Swipe, match, and stay in control of who can find you.',
        }),
      ]),
      card([form]),
      el('button', {
        class: 'btn btn-outline btn-block',
        type: 'button',
        text: isLogin ? 'Create an account' : 'I already have an account',
        onClick: () => {
          mode = isLogin ? 'register' : 'login';
          render();
        },
      }),
    );
  };

  render();
  return wrap;
}

/* --------------------------------------------------------- swipe discover -- */

function swipeCard(intro) {
  const shared = (intro.sharedModes ?? []).map((m) => MODE_LABEL[m] ?? m);
  const others = (intro.interests ?? []).slice(0, 3);

  const background = intro.photoUrl
    ? el('img', { class: 'card-photo', src: intro.photoUrl, alt: '', draggable: 'false' })
    : el('div', {
        class: 'card-fallback',
        style: `background:${gradientFor(intro.id)}`,
        text: (intro.displayName ?? '?').charAt(0).toUpperCase(),
      });

  return el('article', {}, [
    background,
    el('div', { class: 'card-scrim' }),
    el('div', { class: 'stamp stamp-like', dataset: { stamp: 'like' }, text: 'LIKE' }),
    el('div', { class: 'stamp stamp-nope', dataset: { stamp: 'nope' }, text: 'NOPE' }),
    el('button', {
      class: 'card-expand',
      type: 'button',
      'aria-label': `More about ${intro.displayName}`,
      text: 'i',
      onClick: (event) => {
        event.stopPropagation();
        haptic();
        openDetail(intro);
      },
    }),
    el('div', { class: 'card-body' }, [
      el('div', { class: 'card-name' }, [
        el('h2', { text: intro.displayName }),
        intro.age ? el('span', { class: 'card-age', text: String(intro.age) }) : null,
      ]),
      intro.locality ? el('p', { class: 'card-meta', text: intro.locality }) : null,
      intro.headline ? el('p', { class: 'card-bio', text: intro.headline }) : null,
      intro.bio ? el('p', { class: 'card-bio', text: intro.bio }) : null,
      shared.length || others.length
        ? el('div', { class: 'chips' }, [
            ...shared.map((m) => el('span', { class: 'pill pill-shared', text: m })),
            ...others.map((i) => el('span', { class: 'pill', text: i })),
          ])
        : null,
    ]),
  ]);
}

/** Full profile in a bottom sheet, so reading more never loses your place. */
function openDetail(intro) {
  const shared = (intro.sharedModes ?? []).map((m) => MODE_LABEL[m] ?? m);
  sheet(intro.displayName, [
    intro.age || intro.locality
      ? el('p', { class: 'muted', style: 'margin:0 0 .7rem',
          text: [intro.age, intro.locality].filter(Boolean).join(' · ') })
      : null,
    intro.headline ? el('p', { style: 'font-weight:600;margin:0 0 .6rem', text: intro.headline }) : null,
    intro.bio ? el('p', { class: 'selectable', style: 'margin:0 0 .9rem', text: intro.bio }) : null,
    shared.length
      ? el('div', { style: 'margin-bottom:.9rem' }, [
          el('label', { text: 'You both chose' }),
          el('div', { class: 'chips' }, shared.map((m) => el('span', { class: 'pill pill-like', text: m }))),
        ])
      : null,
    (intro.interests ?? []).length
      ? el('div', { style: 'margin-bottom:.9rem' }, [
          el('label', { text: 'Interests' }),
          el('div', { class: 'chips' }, intro.interests.map((i) => el('span', { class: 'pill', text: i }))),
        ])
      : null,
    el('button', {
      class: 'btn btn-danger btn-block',
      type: 'button',
      text: 'Report or block',
      onClick: () => openReport(intro),
    }),
  ]);
}

function matchSplash(name, matchId) {
  const overlay = el('div', { class: 'match-overlay' }, [
    el('div', {}, [
      el('h1', { text: "It's a match" }),
      el('p', { class: 'muted', style: 'margin:.5rem 0 1.5rem', text: `You and ${name} liked each other.` }),
      el('a', {
        class: 'btn btn-block',
        href: `#/chat/${matchId}`,
        text: 'Say something',
        onClick: () => overlay.remove(),
      }),
      el('button', {
        class: 'btn btn-outline btn-block',
        type: 'button',
        style: 'margin-top:.6rem',
        text: 'Keep swiping',
        onClick: () => overlay.remove(),
      }),
    ]),
  ]);
  document.body.append(overlay);
}

async function discoverView() {
  const usable = state.profiles.filter((p) => p.visibility === 'discoverable');
  const profile = usable[0] ?? state.profiles[0];

  if (!profile) {
    mount(
      card([
        el('h3', { text: 'Set up a profile' }),
        el('p', { text: 'Pick what you are looking for, and we will start the introductions.' }),
        el('a', { class: 'btn btn-block', href: '#/profiles', text: 'Create profile' }),
      ], 'card-accent'),
    );
    return;
  }

  if (profile.visibility !== 'discoverable') {
    mount(
      card([
        el('h3', { text: 'You are invisible right now' }),
        el('p', { text: 'Discovery is reciprocal — you can browse once others can find you too.' }),
        el('button', {
          class: 'btn btn-block',
          type: 'button',
          text: 'Become discoverable',
          onClick: async () => {
            await api.patch(`/api/profiles/${profile.id}/visibility`, { visibility: 'discoverable' });
            await loadProfiles();
            route();
          },
        }),
      ], 'card-accent'),
    );
    return;
  }

  let data;
  try {
    data = await api.get(`/api/discovery/${profile.id}`);
  } catch (err) {
    mount(card([el('p', { class: 'error-text', text: messageFor(err) })]));
    return;
  }

  const pending = data.introductions.filter((i) => !i.actedAt);
  const view = document.getElementById('view');
  view.classList.add('is-deck');

  if (!pending.length) {
    view.classList.remove('is-deck');
    mount(
      card([
        el('div', { class: 'empty' }, [
          el('h3', { text: 'That is everyone for today' }),
          el('p', {
            class: 'small',
            style: 'margin-top:.4rem',
            text: `${data.dailyLimit} introductions a day, chosen for shared intentions rather than volume. More tomorrow.`,
          }),
        ]),
        el('a', { class: 'btn btn-outline btn-block', href: '#/matches', text: 'See your matches' }),
      ]),
    );
    return;
  }

  const deckEl = el('div', { class: 'deck' });
  const counter = el('p', { class: 'deck-count' });

  // Shown once, ever. Nothing about a card says "draggable" on its own.
  if (!seen.has('swipe-coach')) {
    const coach = el('div', { class: 'coach' }, [
      el('div', {}, [
        el('div', { class: 'coach-arrows' }, [
          el('div', { class: 'coach-arrow coach-nope' }, [
            svg('<path d="M15 6l-6 6 6 6"/>'), el('span', { text: 'Swipe left to pass' }),
          ]),
          el('div', { class: 'coach-arrow coach-like' }, [
            svg('<path d="M9 6l6 6-6 6"/>'), el('span', { text: 'Swipe right to like' }),
          ]),
        ]),
        el('p', { class: 'small', style: 'color:#fff;opacity:.85;margin:0 0 1rem',
          text: 'Or use the buttons below. Tap a card to read more.' }),
        el('button', {
          class: 'btn', type: 'button', text: 'Got it',
          onClick: () => { seen.mark('swipe-coach'); coach.remove(); haptic(); },
        }),
      ]),
    ]);
    deckEl.append(coach);
  }

  const decide = async (decision, intro) => {
    haptic(decision === 'like' ? 18 : 8);
    try {
      if (decision === 'like') {
        const { matched } = await api.post('/api/likes', {
          fromProfileId: profile.id,
          toProfileId: intro.id,
        });
        if (matched) {
          const { matches } = await api.get('/api/matches');
          const fresh = matches.find((m) => m.profileId === intro.id);
          haptic([30, 60, 30]);
          matchSplash(intro.displayName, fresh?.id ?? '');
        }
      } else {
        await api.post(`/api/introductions/${intro.id}/pass`);
      }
    } catch (err) {
      toast(messageFor(err));
    }
    counter.textContent = `${deck.remaining} left today`;
  };

  const deck = createDeck({
    container: deckEl,
    cards: pending,
    renderCard: swipeCard,
    onDecide: decide,
    onEmpty: () => {
      view.classList.remove('is-deck');
      void discoverView();
    },
  });

  counter.textContent = `${deck.remaining} left today`;

  const actions = el('div', { class: 'deck-actions' }, [
    el('button', {
      class: 'action action-sm action-rewind',
      type: 'button',
      'aria-label': 'Undo last pass',
      onClick: async () => {
        try {
          const { restored } = await api.post('/api/introductions/backtrack');
          toast(`${restored} is back`);
          view.classList.remove('is-deck');
          await discoverView();
        } catch (err) {
          toast(err.code === 'nothing_to_undo' ? 'Nothing to undo' : messageFor(err));
        }
      },
    }, [svg(ICON.rewind)]),
    el('button', {
      class: 'action action-pass',
      type: 'button',
      'aria-label': 'Pass',
      onClick: () => { haptic(8); deck.decide('pass'); },
    }, [svg(ICON.close)]),
    el('button', {
      class: 'action action-like',
      type: 'button',
      'aria-label': 'Like',
      onClick: () => { haptic(18); deck.decide('like'); },
    }, [svg(ICON.heart)]),
    el('button', {
      class: 'action action-sm',
      type: 'button',
      'aria-label': 'Report or block',
      onClick: () => {
        const current = pending[pending.length - deck.remaining];
        if (current) openReport(current);
      },
    }, [svg('<path d="M12 8v5"/><circle cx="12" cy="16.4" r="1"/><circle cx="12" cy="12" r="9"/>')]),
  ]);

  mount(deckEl, el('div', {}, [actions, counter]));
}

function openReport(intro) {
  const select = el('select');
  for (const [value, label] of REPORT_CATEGORIES) select.append(el('option', { value, text: label }));
  const details = el('textarea', { maxlength: '4000' });

  document.getElementById('view').classList.remove('is-deck');
  mount(
    el('h1', { text: `Report ${intro.displayName}` }),
    card([
      el('p', { text: 'Reviewed by a person. Threats, non-consensual imagery and suspected minors are prioritised.' }),
      field('What happened?', select),
      field('Details (optional)', details, 'Shared with moderators only. Never shown to the person reported.'),
      el('button', {
        class: 'btn btn-block',
        type: 'button',
        text: 'Submit and block',
        onClick: async () => {
          try {
            await api.post('/api/reports', {
              profileId: intro.id,
              category: select.value,
              details: details.value.trim() || undefined,
            });
            await api.post('/api/blocks', { profileId: intro.id }).catch(() => {});
            toast('Reported and blocked');
            location.hash = '#/discover';
            route();
          } catch (err) {
            toast(messageFor(err));
          }
        },
      }),
      el('button', {
        class: 'btn btn-outline btn-block',
        type: 'button',
        style: 'margin-top:.5rem',
        text: 'Cancel',
        onClick: () => {
          location.hash = '#/discover';
          route();
        },
      }),
    ]),
  );
}

/* ---------------------------------------------------------------- matches -- */

function timeLeft(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return null;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h left` : `${minutes}m left`;
}

async function matchesView() {
  showSkeleton(3);
  const { matches } = await api.get('/api/matches');
  if (!matches.length) {
    mount(
      el('h1', { text: 'Matches' }),
      card([el('div', { class: 'empty' }, [
        el('p', { text: 'No matches yet.' }),
        el('p', { class: 'small', text: 'A match happens only when you both swipe right.' }),
      ])]),
    );
    return;
  }

  mount(
    el('h1', { text: 'Matches' }),
    el('p', {
      class: 'muted small',
      text: 'A new match has 24 hours to be opened. Whoever was liked first goes first.',
    }),
    ...matches.map((m) => {
      const status = m.expired
        ? el('span', { class: 'pill', text: 'Expired' })
        : m.openedAt
          ? el('span', { class: 'pill pill-like', text: `${m.messageCount} msg` })
          : m.myOpeningMove
            ? el('span', { class: 'pill pill-accent', text: `Your move · ${timeLeft(m.expiresAt) ?? 'now'}` })
            : el('span', { class: 'pill pill-warn', text: `Their move · ${timeLeft(m.expiresAt) ?? 'now'}` });

      return card([
        el('div', { class: 'list-row' }, [
          avatar(m.profileId, m.displayName),
          el('div', { class: 'grow' }, [
            el('h3', { class: 'truncate', text: m.displayName }),
            el('p', { class: 'small muted truncate', style: 'margin:.1rem 0 .3rem', text: m.headline ?? m.locality ?? '' }),
            status,
          ]),
        ]),
        el('div', { class: 'divider' }),
        el('div', { class: 'row' }, [
          m.expired
            ? el('span', { class: 'small muted', text: 'Expired unopened.' })
            : el('a', {
                class: 'btn btn-sm grow center',
                href: `#/chat/${m.id}`,
                text: m.openedAt ? 'Open chat' : m.myOpeningMove ? 'Say something' : 'View',
              }),
          m.canExtend && !m.expired && !m.myOpeningMove
            ? el('button', {
                class: 'btn btn-ghost btn-sm',
                type: 'button',
                text: '+24h',
                onClick: async () => {
                  try {
                    await api.post(`/api/matches/${m.id}/extend`);
                    toast('Extended');
                    route();
                  } catch (err) { toast(messageFor(err)); }
                },
              })
            : null,
        ]),
      ]);
    }),
  );
}

/* ------------------------------------------------------------------- chat -- */

async function chatView(matchId, quiet = false) {
  if (!quiet) showSkeleton(2);
  let data;
  try {
    data = await api.get(`/api/matches/${matchId}/messages`);
  } catch (err) {
    mount(card([el('p', { class: 'error-text', text: messageFor(err) })]));
    return;
  }
  const { match, myProfileId, messages } = data;

  const thread = el('div', { class: 'thread' },
    messages.length
      ? messages.map((msg) =>
          el('div', { class: `bubble ${msg.senderProfileId === myProfileId ? 'bubble-mine' : ''}`.trim() }, [
            el('p', { text: msg.body }),
            el('span', {
              class: 'bubble-time',
              text: new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            }),
          ]))
      : [el('p', { class: 'muted small center', text: 'No messages yet.' })]);

  const input = el('textarea', { maxlength: '4000', placeholder: 'Message…', rows: '1' });
  const send = el('button', { class: 'btn', type: 'submit', text: 'Send' });

  const composer = match.canSend
    ? el('form', {
        class: 'composer',
        onSubmit: async (event) => {
          event.preventDefault();
          const body = input.value.trim();
          if (!body) return;
          send.disabled = true;
          try {
            await api.post(`/api/matches/${matchId}/messages`, { body });
            input.value = '';
            haptic();
            // quiet: skip the skeleton so the thread does not flash on send.
            await chatView(matchId, true);
          } catch (err) { toast(messageFor(err)); }
          finally { send.disabled = false; }
        },
      }, [el('div', { class: 'grow' }, [input]), send])
    : null;

  let notice = null;
  if (match.expired) {
    notice = card([
      el('h3', { text: 'This match expired' }),
      el('p', { text: 'Nobody opened it within 24 hours.' }),
    ], 'card-accent');
  } else if (match.awaitingOther) {
    notice = card([
      el('h3', { text: `${match.otherName} goes first` }),
      el('p', { text: `They were liked first, so the opening move is theirs. ${timeLeft(match.expiresAt) ?? 'Expiring soon'}.` }),
    ], 'card-accent');
  } else if (!match.openedAt) {
    notice = card([
      el('h3', { text: 'Your move' }),
      el('p', { text: `You have ${timeLeft(match.expiresAt) ?? 'a moment'} to start this.` }),
    ], 'card-accent');
  }

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 112)}px`;
  });

  mount(
    el('div', { class: 'row row-between' }, [
      el('div', { class: 'list-row' }, [
        avatar(matchId, match.otherName, 38),
        el('h1', { text: match.otherName, style: 'font-size:1.2rem' }),
      ]),
      el('a', { class: 'btn btn-ghost btn-sm', href: '#/matches', text: 'Back' }),
    ]),
    notice,
    card([thread]),
    composer,
  );

  // A conversation should open at the newest message, not the oldest.
  const pane = document.getElementById('view');
  pane.scrollTop = pane.scrollHeight;
}

/* ------------------------------------------------------------------- feed -- */

async function feedView() {
  showSkeleton(2);
  const kind = location.hash.includes('reel') ? 'reel' : 'story';
  const { posts } = await api.get(`/api/posts?kind=${kind}`);

  const tabs = el('div', { class: 'row' }, [
    el('a', {
      class: `btn btn-sm grow center ${kind === 'story' ? '' : 'btn-ghost'}`,
      href: '#/feed', text: 'Stories · 24h',
    }),
    el('a', {
      class: `btn btn-sm grow center ${kind === 'reel' ? '' : 'btn-ghost'}`,
      href: '#/feed/reel', text: 'Reels · 30d',
    }),
  ]);

  mount(
    el('h1', { text: 'Feed' }),
    tabs,
    el('a', {
      class: 'btn btn-outline btn-block',
      href: kind === 'reel' ? '#/post/reel' : '#/post/story',
      text: kind === 'reel' ? 'Post a reel' : 'Post a story',
    }),
    ...(posts.length
      ? posts.map((p) => card([
          el('div', { class: 'list-row' }, [
            avatar(p.profileId, p.displayName, 40),
            el('div', { class: 'grow' }, [
              el('h3', { class: 'truncate', text: p.displayName }),
              el('p', { class: 'small muted', style: 'margin:0', text: timeLeft(p.expiresAt) ?? 'expiring' }),
            ]),
            p.mine && p.heartsIfMine !== null
              ? el('span', { class: 'pill pill-like', text: `${p.heartsIfMine} ♥` })
              : null,
          ]),
          p.caption ? el('p', { style: 'margin:.6rem 0 0', text: p.caption }) : null,
          p.videoUrl
            ? el('a', {
                class: 'btn btn-ghost btn-sm btn-block',
                style: 'margin-top:.6rem',
                href: p.videoUrl,
                target: '_blank',
                rel: 'noopener noreferrer',
                text: 'Watch on YouTube',
              })
            : null,
          el('div', { class: 'row', style: 'margin-top:.6rem' }, [
            el('button', {
              class: `btn btn-sm ${p.hearted ? '' : 'btn-ghost'}`,
              type: 'button',
              text: p.hearted ? '♥ Liked' : '♡ Like',
              onClick: async (event) => {
                const btn = event.currentTarget;
                try {
                  if (p.hearted) await api.del(`/api/posts/${p.id}/heart`);
                  else await api.post(`/api/posts/${p.id}/heart`);
                  p.hearted = !p.hearted;
                  btn.textContent = p.hearted ? '♥ Liked' : '♡ Like';
                  btn.classList.toggle('btn-ghost', !p.hearted);
                } catch (err) { toast(messageFor(err)); }
              },
            }),
            p.mine
              ? el('button', {
                  class: 'btn btn-danger btn-sm',
                  type: 'button',
                  text: 'Delete',
                  onClick: async () => {
                    await api.del(`/api/posts/${p.id}`);
                    toast('Deleted');
                    route();
                  },
                })
              : null,
          ]),
        ]))
      : [card([el('div', { class: 'empty' }, [
          el('p', { text: kind === 'reel' ? 'No reels yet.' : 'No stories yet.' }),
          el('p', { class: 'small', text: 'Follow people, or post the first one.' }),
        ])])]),
  );
}

async function composeView(kind) {
  const profile = state.profiles[0];
  if (!profile) { location.hash = '#/profiles'; return route(); }

  const caption = el('textarea', { maxlength: '500', placeholder: 'Say something…' });
  const link = el('input', { type: 'url', placeholder: 'https://youtu.be/…' });
  const photo = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
  const error = el('p', { class: 'error-text', hidden: true });

  const submit = el('button', {
    class: 'btn btn-block',
    type: 'button',
    text: kind === 'reel' ? 'Post reel' : 'Post story',
    onClick: async () => {
      error.hidden = true;
      submit.disabled = true;
      try {
        const body = { profileId: profile.id, kind, caption: caption.value.trim() || undefined };
        if (link.value.trim()) body.videoUrl = link.value.trim();
        else if (kind === 'story' && photo.files?.[0]) {
          const form = new FormData();
          form.append('file', photo.files[0]);
          const res = await fetch('/api/media', { method: 'POST', body: form, credentials: 'same-origin' });
          // The body can only be read once, so parse before branching on ok.
          const payload = await res.json();
          if (!res.ok) throw Object.assign(new Error('upload'), { code: payload.error });
          body.mediaId = payload.id;
        }
        await api.post('/api/posts', body);
        toast('Posted');
        location.hash = kind === 'reel' ? '#/feed/reel' : '#/feed';
        route();
      } catch (err) {
        error.textContent = messageFor(err);
        error.hidden = false;
      } finally {
        submit.disabled = false;
      }
    },
  });

  mount(
    el('h1', { text: kind === 'reel' ? 'New reel' : 'New story' }),
    card([
      kind === 'reel'
        ? el('div', {}, [
            el('p', { text: 'Reels live on your own YouTube channel. Upload there, then paste the link — we only store the link.' }),
            el('a', {
              class: 'btn btn-outline btn-block',
              href: 'https://www.youtube.com/upload',
              target: '_blank',
              rel: 'noopener noreferrer',
              text: 'Open YouTube upload',
            }),
            el('div', { class: 'divider' }),
            field('YouTube link', link),
          ])
        : el('div', {}, [
            field('Photo', photo, 'JPEG, PNG or WebP. Expires after 24 hours.'),
            field('…or a YouTube link instead', link, 'Video is never uploaded here.'),
          ]),
      field('Caption', caption),
      error,
      submit,
      el('a', { class: 'btn btn-outline btn-block', style: 'margin-top:.5rem', href: '#/feed', text: 'Cancel' }),
    ]),
  );
}

/* --------------------------------------------------------------- profiles -- */

function profileEditor(existing) {
  const kind = el('select');
  for (const [value, label] of KINDS) {
    kind.append(el('option', { value, text: label, selected: existing?.kind === value }));
  }
  if (existing) kind.disabled = true;

  const displayName = el('input', { type: 'text', maxlength: '60', required: true });
  displayName.value = existing?.displayName ?? '';
  const headline = el('input', { type: 'text', maxlength: '140' });
  headline.value = existing?.headline ?? '';
  const bio = el('textarea', { maxlength: '2000' });
  bio.value = existing?.bio ?? '';
  const locality = el('input', { type: 'text', maxlength: '80' });
  locality.value = existing?.locality ?? '';
  const interests = el('input', { type: 'text' });
  interests.value = (existing?.interests ?? []).join(', ');
  const photo = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });

  const ageMin = el('input', { type: 'number', min: '18', max: '120' });
  ageMin.value = String(existing?.ageMin ?? 18);
  const ageMax = el('input', { type: 'number', min: '18', max: '120' });
  ageMax.value = String(existing?.ageMax ?? 99);

  const modes = chipGroup(MODES, existing?.modes ?? []);
  const visibility = el('select');
  for (const [value, label] of VISIBILITIES) {
    visibility.append(el('option', {
      value, text: label, selected: (existing?.visibility ?? 'invisible') === value,
    }));
  }

  const error = el('p', { class: 'error-text', hidden: true });
  const submit = el('button', {
    class: 'btn btn-block', type: 'submit', text: existing ? 'Save' : 'Create profile',
  });

  return el('form', {
    onSubmit: async (event) => {
      event.preventDefault();
      const chosen = modes.value();
      if (!chosen.length) {
        error.textContent = 'Choose at least one thing you are looking for.';
        error.hidden = false;
        return;
      }
      error.hidden = true;
      submit.disabled = true;
      try {
        let photoMediaId = existing?.photoMediaId ?? null;
        if (photo.files?.[0]) {
          const form = new FormData();
          form.append('file', photo.files[0]);
          const res = await fetch('/api/media', { method: 'POST', body: form, credentials: 'same-origin' });
          const payload = await res.json();
          if (!res.ok) throw Object.assign(new Error('upload'), { code: payload.error });
          photoMediaId = payload.id;
        }
        await api.put('/api/profiles', {
          kind: kind.value,
          displayName: displayName.value.trim(),
          headline: headline.value.trim() || undefined,
          bio: bio.value.trim() || undefined,
          locality: locality.value.trim() || undefined,
          interests: interests.value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20),
          visibility: visibility.value,
          photoMediaId,
          ageMin: Number(ageMin.value),
          ageMax: Number(ageMax.value),
          modes: chosen,
        });
        await loadProfiles();
        toast('Saved');
        location.hash = '#/profiles';
        route();
      } catch (err) {
        error.textContent = messageFor(err);
        error.hidden = false;
      } finally {
        submit.disabled = false;
      }
    },
  }, [
    field('Purpose', kind, existing ? 'Cannot be changed later.' : 'Each purpose is a separate profile.'),
    field('Photo', photo, existing?.photoMediaId ? 'A photo is set. Choose a new file to replace it.' : 'Shown on your card.'),
    field('Name', displayName),
    field('Headline', headline),
    field('About you', bio),
    field('Town or city', locality, 'Approximate only — never your exact location.'),
    field('Interests', interests, 'Comma separated.'),
    el('div', { class: 'field' }, [
      el('label', { text: 'Looking for' }),
      modes.node,
      el('p', { class: 'hint', text: 'You only meet people who chose at least one of the same.' }),
    ]),
    el('div', { class: 'row' }, [
      el('div', { class: 'grow' }, [field('Youngest', ageMin)]),
      el('div', { class: 'grow' }, [field('Oldest', ageMax)]),
    ]),
    field('Who can find you', visibility, 'New profiles start invisible.'),
    error,
    submit,
  ]);
}

async function profilesView() {
  showSkeleton(2);
  let stats = null;
  try { stats = await api.get('/api/me/stats'); } catch { /* not fatal */ }

  const children = [el('h1', { text: 'Your profiles' })];

  if (stats) {
    children.push(card([
      el('div', { class: 'row row-between' }, [
        el('div', { class: 'center grow' }, [
          el('h3', { text: String(stats.heartsReceived) }),
          el('p', { class: 'small muted', style: 'margin:0', text: 'hearts' }),
        ]),
        el('div', { class: 'center grow' }, [
          el('h3', { text: String(stats.followers) }),
          el('p', { class: 'small muted', style: 'margin:0', text: 'followers' }),
        ]),
        el('div', { class: 'center grow' }, [
          el('h3', { text: String(stats.livePosts) }),
          el('p', { class: 'small muted', style: 'margin:0', text: 'live posts' }),
        ]),
      ]),
      el('p', { class: 'hint center', text: 'Only you can see these numbers.' }),
    ]));
  }

  for (const profile of state.profiles) {
    children.push(card([
      el('div', { class: 'list-row' }, [
        avatar(profile.id, profile.displayName),
        el('div', { class: 'grow' }, [
          el('h3', { class: 'truncate', text: profile.displayName }),
          el('p', { class: 'small muted truncate', style: 'margin:.1rem 0', text: profile.headline ?? '' }),
          el('span', {
            class: profile.visibility === 'discoverable' ? 'pill pill-accent' : 'pill',
            text: KINDS.find(([k]) => k === profile.kind)?.[1] ?? profile.kind,
          }),
        ]),
      ]),
      el('div', { class: 'chips', style: 'margin-top:.6rem' },
        profile.modes.map((m) => el('span', { class: 'pill', text: MODE_LABEL[m] ?? m }))),
      el('div', { class: 'divider' }),
      el('div', { class: 'row' }, [
        el('a', { class: 'btn btn-ghost btn-sm grow center', href: `#/profiles/${profile.id}/edit`, text: 'Edit' }),
        el('button', {
          class: 'btn btn-ghost btn-sm',
          type: 'button',
          text: 'QR',
          onClick: async () => {
            const { token, expiresInSeconds } = await api.post(`/api/qr/${profile.id}`);
            mount(
              el('h1', { text: 'Connect in person' }),
              card([
                el('p', { text: `Show this code. It works once and expires in ${Math.round(expiresInSeconds / 60)} minutes.` }),
                el('p', { class: 'selectable center', style: 'font-size:1.1rem;font-weight:800;word-break:break-all', text: token }),
                el('a', { class: 'btn btn-outline btn-block', href: '#/profiles', text: 'Done' }),
              ]),
            );
          },
        }),
        el('button', {
          class: 'btn btn-danger btn-sm',
          type: 'button',
          text: 'Delete',
          onClick: async () => {
            if (!confirmAction(`Delete your ${profile.kind} profile?`)) return;
            await api.del(`/api/profiles/${profile.id}`);
            await loadProfiles();
            toast('Deleted');
            route();
          },
        }),
      ]),
    ]));
  }

  if (state.profiles.length < KINDS.length) {
    children.push(card([el('h2', { text: 'Add a profile' }), profileEditor(null)]));
  }
  mount(...children);
}

/* ---------------------------------------------------------------- privacy -- */

async function privacyView() {
  showSkeleton(3);
  const { consents } = await api.get('/api/consents');

  mount(
    el('h1', { text: 'Privacy' }),
    card([
      el('h2', { text: 'Consent' }),
      el('p', { text: 'Each is separate, off by default, and reversible.' }),
      ...consents.map((c) => {
        const input = el('input', {
          type: 'checkbox',
          checked: c.granted,
          onChange: async (event) => {
            try {
              await api.put(`/api/consents/${c.kind}`, { granted: event.target.checked });
              toast(event.target.checked ? 'Consent granted' : 'Consent withdrawn');
            } catch (err) {
              event.target.checked = !event.target.checked;
              toast(messageFor(err));
            }
          },
        });
        return el('div', { class: 'switch' }, [
          input,
          el('div', { class: 'grow' }, [
            el('div', { class: 'switch-label', text: c.label }),
            el('p', { class: 'hint', text: c.explains }),
          ]),
        ]);
      }),
    ], 'card-accent'),

    card([
      el('h2', { text: 'Your data' }),
      el('button', {
        class: 'btn btn-ghost btn-block',
        type: 'button',
        text: 'Export everything',
        onClick: async () => {
          const data = await api.get('/api/privacy/export');
          const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
          el('a', { href: url, download: 'sirony-connect-export.json' }).click();
          URL.revokeObjectURL(url);
        },
      }),
    ]),

    card([
      el('h2', { text: 'Account' }),
      el('button', {
        class: 'btn btn-ghost btn-block',
        type: 'button',
        text: 'Sign out',
        onClick: async () => {
          await api.post('/api/auth/logout');
          state.user = null;
          state.profiles = [];
          location.hash = '#/';
          route();
        },
      }),
      el('button', {
        class: 'btn btn-ghost btn-block',
        type: 'button',
        style: 'margin-top:.5rem',
        text: 'Pause account',
        onClick: async () => {
          if (!confirmAction('Pause your account? Profiles hidden until you sign back in.')) return;
          await api.post('/api/auth/pause');
          state.user = null;
          location.hash = '#/';
          route();
        },
      }),
      el('div', { class: 'divider' }),
      el('p', { class: 'hint', text: 'Deleting removes your profiles, likes and matches permanently.' }),
      el('button', {
        class: 'btn btn-danger btn-block',
        type: 'button',
        text: 'Delete my account',
        onClick: async () => {
          if (!confirmAction('Permanently delete your account? This cannot be undone.')) return;
          await api.del('/api/auth/account');
          state.user = null;
          state.profiles = [];
          location.hash = '#/';
          route();
        },
      }),
    ]),
  );
}

/* ----------------------------------------------------------------- router -- */

async function loadProfiles() {
  const { profiles } = await api.get('/api/profiles');
  state.profiles = profiles;
}

function syncTabs(active) {
  const tabbar = document.getElementById('tabbar');
  tabbar.hidden = !state.user;
  for (const link of tabbar.querySelectorAll('a')) {
    if (link.dataset.tab === active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const view = document.getElementById('view');
  view.classList.remove('is-deck');
  document.querySelector('.match-overlay')?.remove();

  if (!state.user) {
    syncTabs(null);
    view.replaceChildren(...authView().childNodes);
    return;
  }

  try {
    switch (parts[0]) {
      case 'matches': syncTabs('matches'); await matchesView(); break;
      case 'chat': syncTabs('matches'); await chatView(parts[1]); break;
      case 'feed': syncTabs('feed'); await feedView(); break;
      case 'post': syncTabs('feed'); await composeView(parts[1] === 'reel' ? 'reel' : 'story'); break;
      case 'privacy': syncTabs('privacy'); await privacyView(); break;
      case 'profiles':
        syncTabs('profiles');
        if (parts[2] === 'edit') {
          mount(el('h1', { text: 'Edit profile' }),
            card([profileEditor(state.profiles.find((p) => p.id === parts[1]))]));
        } else {
          await profilesView();
        }
        break;
      case 'welcome': syncTabs(null); onboardingView(); break;
      default:
        // A first-time user gets the guided flow, not an empty deck.
        if (!state.profiles.length) { syncTabs(null); onboardingView(); break; }
        syncTabs('discover');
        await discoverView();
    }
  } catch (err) {
    if (err.status === 401) { state.user = null; return route(); }
    mount(card([el('p', { class: 'error-text', text: messageFor(err) })]));
  }
}

async function boot() {
  try {
    state.user = await api.get('/api/auth/me');
    await loadProfiles();
  } catch {
    state.user = null;
    state.profiles = [];
  }
}

/* -------------------------------------------------------- PWA integration -- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      reg.addEventListener('updatefound', () => {
        const incoming = reg.installing;
        incoming?.addEventListener('statechange', () => {
          if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
            incoming.postMessage('SKIP_WAITING');
          }
        });
      });
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return;
        reloading = true;
        location.reload();
      });
    } catch (error) {
      console.warn('service worker registration failed', error);
    }
  });
}

let deferredPrompt = null;
const installBtn = document.getElementById('install-btn');
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredPrompt = event;
  installBtn.hidden = false;
});
installBtn?.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  installBtn.hidden = true;
});

window.addEventListener('hashchange', route);
await boot();
await route();
