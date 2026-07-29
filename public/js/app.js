import { api, messageFor } from './api.js';
import { card, chipGroup, confirmAction, el, field, mount, toast } from './ui.js';

/* ------------------------------------------------------------ constants -- */

const MODES = [
  ['marriage', 'Marriage'],
  ['long_term', 'Long-term relationship'],
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

// Ordered most private first — the default is the most private option.
const VISIBILITIES = [
  ['invisible', 'Invisible — nobody can discover this profile'],
  ['audiences', 'Selected audiences only'],
  ['clubs_events', 'Clubs and events only'],
  ['discoverable', 'Discoverable — can appear in introductions'],
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

/* ------------------------------------------------------------ auth views -- */

function authView() {
  let mode = 'login';
  const container = el('div');

  const render = () => {
    const isLogin = mode === 'login';
    const email = el('input', { type: 'email', id: 'email', required: true, autocomplete: 'email' });
    const password = el('input', {
      type: 'password',
      id: 'password',
      required: true,
      minlength: '12',
      autocomplete: isLogin ? 'current-password' : 'new-password',
    });
    const dob = el('input', { type: 'date', id: 'dob', required: true });
    const error = el('p', { class: 'error-text', hidden: true });
    const submit = el('button', { class: 'btn', type: 'submit', text: isLogin ? 'Sign in' : 'Create account' });

    const form = el(
      'form',
      {
        onSubmit: async (event) => {
          event.preventDefault();
          error.hidden = true;
          submit.disabled = true;
          try {
            if (isLogin) {
              await api.post('/api/auth/login', { email: email.value, password: password.value });
            } else {
              await api.post('/api/auth/register', {
                email: email.value,
                password: password.value,
                dateOfBirth: dob.value,
              });
            }
            await boot();
            location.hash = '#/profiles';
          } catch (err) {
            error.textContent = messageFor(err);
            error.hidden = false;
          } finally {
            submit.disabled = false;
          }
        },
      },
      [
        field('Email', email),
        field(
          'Password',
          password,
          isLogin ? undefined : 'At least 12 characters. Longer is stronger.',
        ),
        isLogin
          ? null
          : field(
              'Date of birth',
              dob,
              'Sirony Connect is adults only. Your date of birth is never shown on your profile.',
            ),
        error,
        el('div', { class: 'row' }, [submit]),
      ],
    );

    container.replaceChildren(
      card([
        el('h3', { text: isLogin ? 'Welcome back' : 'Create your account' }),
        el('p', {
          text: isLogin
            ? 'Sign in to see your introductions.'
            : 'Intentional introductions, strong privacy controls, and no attention-farming.',
        }),
        form,
        el('div', { class: 'divider' }),
        el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          text: isLogin ? 'Create an account instead' : 'I already have an account',
          onClick: () => {
            mode = isLogin ? 'register' : 'login';
            render();
          },
        }),
      ]),
    );
  };

  render();
  return [
    el('h1', { text: 'Connection, on your terms' }),
    el('p', {
      class: 'muted',
      text: 'Choose what you are looking for, control who can find you, and withdraw consent at any time.',
    }),
    container,
  ];
}

/* -------------------------------------------------------------- profiles -- */

function profileEditor(existing) {
  const kind = el('select', { id: 'kind' });
  for (const [value, label] of KINDS) {
    kind.append(el('option', { value, text: label, selected: existing?.kind === value }));
  }
  if (existing) kind.disabled = true;

  const displayName = el('input', { type: 'text', id: 'displayName', maxlength: '60', required: true });
  displayName.value = existing?.displayName ?? '';
  const headline = el('input', { type: 'text', id: 'headline', maxlength: '140' });
  headline.value = existing?.headline ?? '';
  const bio = el('textarea', { id: 'bio', maxlength: '2000' });
  bio.value = existing?.bio ?? '';
  const locality = el('input', { type: 'text', id: 'locality', maxlength: '80' });
  locality.value = existing?.locality ?? '';
  const interests = el('input', { type: 'text', id: 'interests' });
  interests.value = (existing?.interests ?? []).join(', ');

  const ageMin = el('input', { type: 'number', id: 'ageMin', min: '18', max: '120' });
  ageMin.value = String(existing?.ageMin ?? 18);
  const ageMax = el('input', { type: 'number', id: 'ageMax', min: '18', max: '120' });
  ageMax.value = String(existing?.ageMax ?? 99);

  const modes = chipGroup(MODES, existing?.modes ?? []);

  const visibility = el('select', { id: 'visibility' });
  for (const [value, label] of VISIBILITIES) {
    visibility.append(
      el('option', { value, text: label, selected: (existing?.visibility ?? 'invisible') === value }),
    );
  }

  const error = el('p', { class: 'error-text', hidden: true });
  const submit = el('button', { class: 'btn', type: 'submit', text: existing ? 'Save profile' : 'Create profile' });

  return el(
    'form',
    {
      onSubmit: async (event) => {
        event.preventDefault();
        const chosenModes = modes.value();
        if (chosenModes.length === 0) {
          error.textContent = 'Choose at least one connection mode.';
          error.hidden = false;
          return;
        }
        error.hidden = true;
        submit.disabled = true;
        try {
          await api.put('/api/profiles', {
            kind: kind.value,
            displayName: displayName.value.trim(),
            headline: headline.value.trim() || undefined,
            bio: bio.value.trim() || undefined,
            locality: locality.value.trim() || undefined,
            interests: interests.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
              .slice(0, 20),
            visibility: visibility.value,
            ageMin: Number(ageMin.value),
            ageMax: Number(ageMax.value),
            modes: chosenModes,
          });
          await loadProfiles();
          toast('Profile saved');
          location.hash = '#/profiles';
          route();
        } catch (err) {
          error.textContent = messageFor(err);
          error.hidden = false;
        } finally {
          submit.disabled = false;
        }
      },
    },
    [
      field('Purpose', kind, existing ? 'Purpose cannot be changed after creation.' : 'Each purpose is a separate profile with its own audience.'),
      field('Display name', displayName),
      field('Headline', headline),
      field('About you', bio),
      field('Town or city', locality, 'Approximate only. Your precise location is never stored or shown.'),
      field('Interests', interests, 'Comma separated, up to 20.'),
      el('div', { class: 'field' }, [
        el('label', { text: 'What are you open to?' }),
        modes.node,
        el('p', {
          class: 'hint',
          text: 'You are only introduced to people who chose at least one of the same modes.',
        }),
      ]),
      el('div', { class: 'row' }, [
        el('div', { style: 'flex:1' }, [field('Youngest', ageMin)]),
        el('div', { style: 'flex:1' }, [field('Oldest', ageMax)]),
      ]),
      field('Who can discover you', visibility, 'New profiles start invisible. Nothing is discoverable until you choose.'),
      error,
      el('div', { class: 'row' }, [submit]),
    ],
  );
}

async function profilesView() {
  const children = [el('h1', { text: 'Your profiles' })];

  if (state.profiles.length === 0) {
    children.push(
      card([
        el('h3', { text: 'Create your first profile' }),
        el('p', {
          text: 'Separate profiles keep dating, friendship, activities and professional networking apart. Start with one.',
        }),
      ], 'card-accent'),
    );
  }

  for (const profile of state.profiles) {
    const visLabel = VISIBILITIES.find(([v]) => v === profile.visibility)?.[1] ?? profile.visibility;
    children.push(
      card([
        el('div', { class: 'row', style: 'justify-content:space-between;align-items:center' }, [
          el('h3', { text: profile.displayName, style: 'margin:0' }),
          el('span', {
            class: profile.visibility === 'discoverable' ? 'pill pill-accent' : 'pill',
            text: KINDS.find(([k]) => k === profile.kind)?.[1] ?? profile.kind,
          }),
        ]),
        profile.headline ? el('p', { text: profile.headline }) : null,
        el('p', { class: 'small muted', text: visLabel }),
        el('div', { class: 'chips' }, profile.modes.map((m) => el('span', { class: 'pill', text: MODE_LABEL[m] ?? m }))),
        el('div', { class: 'divider' }),
        el('div', { class: 'row' }, [
          el('a', { class: 'btn btn-ghost btn-sm', href: `#/profiles/${profile.id}/edit`, text: 'Edit' }),
          el('a', { class: 'btn btn-ghost btn-sm', href: `#/discover/${profile.id}`, text: 'Introductions' }),
          el('button', {
            class: 'btn btn-danger btn-sm',
            type: 'button',
            text: 'Delete',
            onClick: async () => {
              if (!confirmAction(`Delete your ${profile.kind} profile? This cannot be undone.`)) return;
              await api.del(`/api/profiles/${profile.id}`);
              await loadProfiles();
              toast('Profile deleted');
              route();
            },
          }),
        ]),
      ]),
    );
  }

  const canAdd = state.profiles.length < KINDS.length;
  if (canAdd) {
    children.push(card([el('h2', { text: 'Add a profile' }), profileEditor(null)]));
  }
  mount(...children);
}

/* ------------------------------------------------------------- discovery -- */

function introductionCard(profileId, intro, refresh) {
  const shared = (intro.sharedModes ?? []).map((m) => MODE_LABEL[m] ?? m);

  const actions = el('div', { class: 'row' }, [
    el('button', {
      class: 'btn',
      type: 'button',
      text: 'Connect',
      onClick: async () => {
        try {
          const { matched } = await api.post('/api/likes', {
            fromProfileId: profileId,
            toProfileId: intro.id,
          });
          toast(matched ? "It's a match — you can both see each other now" : 'Interest sent');
          await refresh();
        } catch (err) {
          toast(messageFor(err));
        }
      },
    }),
    el('button', {
      class: 'btn btn-ghost',
      type: 'button',
      text: 'Pass',
      onClick: async () => {
        await api.post(`/api/introductions/${intro.id}/pass`);
        await refresh();
      },
    }),
    el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      text: 'Block',
      onClick: async () => {
        if (!confirmAction('Block this person? They will not be able to find or contact you.')) return;
        await api.post('/api/blocks', { profileId: intro.id });
        toast('Blocked');
        await refresh();
      },
    }),
    el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      text: 'Report',
      onClick: () => openReport(intro, refresh),
    }),
  ]);

  return card([
    el('div', { class: 'row', style: 'justify-content:space-between;align-items:baseline' }, [
      el('h3', { text: intro.displayName, style: 'margin:0' }),
      el('span', { class: 'pill', text: `${intro.age}` }),
    ]),
    intro.headline ? el('p', { text: intro.headline }) : null,
    intro.locality ? el('p', { class: 'small muted', text: intro.locality }) : null,
    intro.bio ? el('p', { text: intro.bio }) : null,
    shared.length
      ? el('div', {}, [
          el('p', { class: 'small muted', text: 'Why you were introduced' }),
          el('div', { class: 'chips' }, shared.map((m) => el('span', { class: 'pill pill-ok', text: m }))),
        ])
      : null,
    (intro.sharedInterests ?? []).length
      ? el('div', { class: 'chips', style: 'margin-top:.5rem' },
          intro.sharedInterests.map((i) => el('span', { class: 'pill', text: i })))
      : null,
    el('div', { class: 'divider' }),
    actions,
  ]);
}

function openReport(intro, refresh) {
  const select = el('select', { id: 'category' });
  for (const [value, label] of REPORT_CATEGORIES) select.append(el('option', { value, text: label }));
  const details = el('textarea', { id: 'details', maxlength: '4000' });

  mount(
    el('h1', { text: 'Report' }),
    card([
      el('p', { text: `Reporting ${intro.displayName}. Reports are reviewed by a person. Threats, non-consensual imagery and suspected minors are prioritised.` }),
      field('What happened?', select),
      field('Details (optional)', details, 'Shared with moderators only. Never shown to the person reported.'),
      el('div', { class: 'row' }, [
        el('button', {
          class: 'btn',
          type: 'button',
          text: 'Submit report',
          onClick: async () => {
            try {
              await api.post('/api/reports', {
                profileId: intro.id,
                category: select.value,
                details: details.value.trim() || undefined,
              });
              await api.post('/api/blocks', { profileId: intro.id }).catch(() => {});
              toast('Report submitted and user blocked');
              await refresh();
            } catch (err) {
              toast(messageFor(err));
            }
          },
        }),
        el('button', { class: 'btn btn-ghost', type: 'button', text: 'Cancel', onClick: () => route() }),
      ]),
    ]),
  );
}

async function discoverView(profileId) {
  const usable = state.profiles.filter((p) => p.visibility === 'discoverable');
  const profile = state.profiles.find((p) => p.id === profileId) ?? usable[0] ?? state.profiles[0];

  if (!profile) {
    mount(
      el('h1', { text: 'Discover' }),
      card([
        el('h3', { text: 'Create a profile first' }),
        el('p', { text: 'Introductions are matched on the purpose and modes you choose.' }),
        el('a', { class: 'btn', href: '#/profiles', text: 'Set up a profile' }),
      ]),
    );
    return;
  }

  if (profile.visibility !== 'discoverable') {
    mount(
      el('h1', { text: 'Discover' }),
      card([
        el('h3', { text: 'This profile is not discoverable' }),
        el('p', { text: 'You can browse only when others can also find you. This keeps discovery reciprocal.' }),
        el('button', {
          class: 'btn',
          type: 'button',
          text: 'Make discoverable',
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

  const refresh = async () => discoverView(profile.id);
  let data;
  try {
    data = await api.get(`/api/discovery/${profile.id}`);
  } catch (err) {
    mount(el('h1', { text: 'Discover' }), card([el('p', { text: messageFor(err) })]));
    return;
  }

  const pending = data.introductions.filter((i) => !i.actedAt);
  mount(
    el('h1', { text: "Today's introductions" }),
    el('p', { class: 'muted small', text: `${data.explanation} Up to ${data.dailyLimit} a day, so each one gets your attention.` }),
    el('div', { class: 'row' }, [
      el('button', {
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        text: 'Undo last pass',
        onClick: async () => {
          try {
            const { restored } = await api.post('/api/introductions/backtrack');
            toast(`${restored} is back`);
            await refresh();
          } catch (err) {
            toast(err.code === 'nothing_to_undo' ? 'Nothing to undo' : messageFor(err));
          }
        },
      }),
    ]),
    ...(pending.length
      ? pending.map((intro) => introductionCard(profile.id, intro, refresh))
      : [
          card([
            el('div', { class: 'empty' }, [
              el('p', { text: 'No introductions left today.' }),
              el('p', { class: 'small', text: 'New ones arrive tomorrow. Quality over volume.' }),
            ]),
          ]),
        ]),
  );
}

/* --------------------------------------------------------------- matches -- */

/** "4h 12m left" — the opening window, shown plainly rather than as a timer. */
function timeLeft(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return null;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m left` : `${minutes}m left`;
}

function matchStatus(m) {
  if (m.expired) return { text: 'Expired', kind: 'pill' };
  if (m.openedAt) return { text: `${m.messageCount} message${m.messageCount === 1 ? '' : 's'}`, kind: 'pill pill-ok' };
  if (m.myOpeningMove) return { text: `Your move · ${timeLeft(m.expiresAt) ?? 'expiring'}`, kind: 'pill pill-accent' };
  return { text: `Their move · ${timeLeft(m.expiresAt) ?? 'expiring'}`, kind: 'pill pill-warn' };
}

async function matchesView() {
  const { matches } = await api.get('/api/matches');
  mount(
    el('h1', { text: 'Matches' }),
    el('p', {
      class: 'muted small',
      text: 'A new match has 24 hours to be opened. Whoever was liked first makes the opening move; after that either of you can reply.',
    }),
    ...(matches.length
      ? matches.map((m) => {
          const status = matchStatus(m);
          return card([
            el('div', { class: 'row', style: 'justify-content:space-between;align-items:baseline' }, [
              el('h3', { text: m.displayName, style: 'margin:0' }),
              el('span', { class: status.kind, text: status.text }),
            ]),
            m.headline ? el('p', { text: m.headline }) : null,
            m.locality ? el('p', { class: 'small muted', text: m.locality }) : null,
            el('div', { class: 'divider' }),
            el('div', { class: 'row' }, [
              m.expired
                ? el('span', { class: 'small muted', text: 'This match expired unopened.' })
                : el('a', {
                    class: 'btn btn-sm',
                    href: `#/chat/${m.id}`,
                    text: m.openedAt ? 'Open chat' : m.myOpeningMove ? 'Say something' : 'View',
                  }),
              m.canExtend && !m.expired && !m.myOpeningMove
                ? el('button', {
                    class: 'btn btn-ghost btn-sm',
                    type: 'button',
                    text: 'Extend 24h',
                    onClick: async () => {
                      try {
                        await api.post(`/api/matches/${m.id}/extend`);
                        toast('Extended by 24 hours');
                        route();
                      } catch (err) {
                        toast(messageFor(err));
                      }
                    },
                  })
                : null,
              el('button', {
                class: 'btn btn-danger btn-sm',
                type: 'button',
                text: 'Block',
                onClick: async () => {
                  if (!confirmAction('Block this person? The match will be closed.')) return;
                  await api.post('/api/blocks', { profileId: m.profileId });
                  toast('Blocked');
                  route();
                },
              }),
            ]),
          ]);
        })
      : [card([el('div', { class: 'empty' }, [
          el('p', { text: 'No matches yet.' }),
          el('p', { class: 'small', text: 'A match happens only when interest is mutual.' }),
        ])])]),
  );
}

/* ------------------------------------------------------------------ chat -- */

async function chatView(matchId) {
  let data;
  try {
    data = await api.get(`/api/matches/${matchId}/messages`);
  } catch (err) {
    mount(el('h1', { text: 'Chat' }), card([el('p', { text: messageFor(err) })]));
    return;
  }

  const { match, myProfileId, messages } = data;

  const thread = el('div', { class: 'stack' },
    messages.length
      ? messages.map((msg) =>
          el('div', { class: `bubble ${msg.senderProfileId === myProfileId ? 'bubble-mine' : ''}`.trim() }, [
            el('p', { text: msg.body, style: 'margin:0' }),
            el('span', {
              class: 'bubble-time',
              text: new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            }),
          ]),
        )
      : [el('p', { class: 'muted small', text: 'No messages yet.' })],
  );

  const input = el('textarea', { id: 'composer', maxlength: '4000', placeholder: 'Write a message' });
  const send = el('button', { class: 'btn', type: 'submit', text: 'Send' });

  const composer = match.canSend
    ? el('form', {
        onSubmit: async (event) => {
          event.preventDefault();
          const body = input.value.trim();
          if (!body) return;
          send.disabled = true;
          try {
            await api.post(`/api/matches/${matchId}/messages`, { body });
            input.value = '';
            await chatView(matchId);
          } catch (err) {
            toast(messageFor(err));
          } finally {
            send.disabled = false;
          }
        },
      }, [input, el('div', { class: 'row row-end', style: 'margin-top:.6rem' }, [send])])
    : null;

  let notice = null;
  if (match.expired) {
    notice = card([
      el('h3', { text: 'This match expired' }),
      el('p', { text: 'Nobody opened the conversation within 24 hours, so it closed. Fewer, more deliberate connections is the point.' }),
    ], 'card-accent');
  } else if (match.awaitingOther) {
    notice = card([
      el('h3', { text: `Waiting for ${match.otherName}` }),
      el('p', { text: `They were liked first, so the opening move is theirs. ${timeLeft(match.expiresAt) ?? 'Expiring shortly'}.` }),
      match.canExtend
        ? el('button', {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            text: 'Give them another 24 hours',
            onClick: async () => {
              await api.post(`/api/matches/${matchId}/extend`);
              toast('Extended');
              await chatView(matchId);
            },
          })
        : null,
    ], 'card-accent');
  } else if (!match.openedAt) {
    notice = card([
      el('h3', { text: 'Your opening move' }),
      el('p', { text: `You have ${timeLeft(match.expiresAt) ?? 'a moment'} to start this conversation.` }),
    ], 'card-accent');
  }

  const ttl = el('select', { id: 'ttl' });
  for (const [value, label] of [
    ['', 'Keep messages'],
    ['3600', 'Disappear after 1 hour'],
    ['86400', 'Disappear after 24 hours'],
    ['604800', 'Disappear after 7 days'],
  ]) {
    ttl.append(el('option', {
      value,
      text: label,
      selected: String(match.messageTtlSeconds ?? '') === value,
    }));
  }
  ttl.addEventListener('change', async () => {
    await api.put(`/api/matches/${matchId}/retention`, {
      ttlSeconds: ttl.value ? Number(ttl.value) : null,
    });
    toast('Retention updated');
  });

  mount(
    el('div', { class: 'row', style: 'justify-content:space-between;align-items:center' }, [
      el('h1', { text: match.otherName, style: 'margin:0' }),
      el('a', { class: 'btn btn-ghost btn-sm', href: '#/matches', text: 'Back' }),
    ]),
    notice,
    card([thread, composer ? el('div', { class: 'divider' }) : null, composer]),
    card([
      el('h2', { text: 'Message retention' }),
      el('p', { text: 'Applies to both sides of this conversation, and to new messages only.' }),
      ttl,
    ]),
  );
}

/* --------------------------------------------------------------- privacy -- */

async function privacyView() {
  const { consents } = await api.get('/api/consents');

  const toggles = consents.map((consent) => {
    const input = el('input', {
      type: 'checkbox',
      id: `consent-${consent.kind}`,
      checked: consent.granted,
      onChange: async (event) => {
        try {
          await api.put(`/api/consents/${consent.kind}`, { granted: event.target.checked });
          toast(event.target.checked ? 'Consent granted' : 'Consent withdrawn');
        } catch (err) {
          event.target.checked = !event.target.checked;
          toast(messageFor(err));
        }
      },
    });
    return el('div', { class: 'switch' }, [
      input,
      el('div', { class: 'switch-body' }, [
        el('div', { class: 'switch-label', text: consent.label }),
        el('p', { class: 'hint', text: consent.explains }),
      ]),
    ]);
  });

  mount(
    el('h1', { text: 'Privacy' }),
    card([
      el('h2', { text: 'Consent' }),
      el('p', { text: 'Each of these is separate, off by default, and reversible at any time.' }),
      ...toggles,
    ], 'card-accent'),

    card([
      el('h2', { text: 'Your data' }),
      el('p', { text: 'Download everything held about you, as JSON.' }),
      el('button', {
        class: 'btn btn-ghost',
        type: 'button',
        text: 'Export my data',
        onClick: async () => {
          const data = await api.get('/api/privacy/export');
          const url = URL.createObjectURL(
            new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
          );
          const link = el('a', { href: url, download: 'sirony-connect-export.json' });
          link.click();
          URL.revokeObjectURL(url);
        },
      }),
    ]),

    card([
      el('h2', { text: 'Account' }),
      el('p', { text: 'Pausing hides your profiles and signs you out everywhere. You can come back.' }),
      el('div', { class: 'row' }, [
        el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          text: 'Pause account',
          onClick: async () => {
            if (!confirmAction('Pause your account? Your profiles will be hidden until you sign back in.')) return;
            await api.post('/api/auth/pause');
            state.user = null;
            location.hash = '#/';
            route();
          },
        }),
        el('button', {
          class: 'btn btn-ghost',
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
      ]),
      el('div', { class: 'divider' }),
      el('p', { class: 'small muted', text: 'Deleting removes your profiles, likes and matches permanently. Moderation records are kept without your personal details.' }),
      el('button', {
        class: 'btn btn-danger',
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

/* ---------------------------------------------------------------- router -- */

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
  const hash = location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/').filter(Boolean);

  if (!state.user) {
    syncTabs(null);
    mount(...authView());
    return;
  }

  try {
    switch (parts[0]) {
      case 'matches':
        syncTabs('matches');
        await matchesView();
        break;
      case 'chat':
        syncTabs('matches');
        await chatView(parts[1]);
        break;
      case 'privacy':
        syncTabs('privacy');
        await privacyView();
        break;
      case 'discover':
        syncTabs('discover');
        await discoverView(parts[1]);
        break;
      case 'profiles':
        syncTabs('profiles');
        if (parts[2] === 'edit') {
          const profile = state.profiles.find((p) => p.id === parts[1]);
          mount(el('h1', { text: 'Edit profile' }), card([profileEditor(profile)]));
        } else {
          await profilesView();
        }
        break;
      default:
        syncTabs('discover');
        await discoverView();
    }
  } catch (err) {
    if (err.status === 401) {
      state.user = null;
      route();
      return;
    }
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

/* ------------------------------------------------------ PWA integration -- */

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

const banner = document.getElementById('offline-banner');
const syncOnline = () => {
  banner.hidden = navigator.onLine;
};
window.addEventListener('online', syncOnline);
window.addEventListener('offline', syncOnline);
syncOnline();

window.addEventListener('hashchange', route);
await boot();
await route();
