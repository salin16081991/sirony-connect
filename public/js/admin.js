/**
 * Admin panel. Deliberately a different shape from the rest of the app: dense
 * tables, wide layout, no swipe gestures. Operator tooling, not a phone app.
 */
import { api, messageFor } from './api.js';
import { card, el, mount, sheet, showSkeleton, toast } from './ui.js';

const SECTIONS = [
  ['overview', 'Overview'],
  ['users', 'Users'],
  ['content', 'Content'],
  ['clubs', 'Clubs'],
  ['events', 'Events'],
  ['reports', 'Reports'],
  ['audit', 'Audit'],
  ['access', 'Access log'],
];

const fmt = (n) => new Intl.NumberFormat().format(n ?? 0);
const bytes = (n) => {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n ?? 0);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

function nav(active) {
  return el('div', { class: 'admin-nav' },
    SECTIONS.map(([key, label]) =>
      el('a', {
        href: `#/admin/${key}`,
        class: `admin-tab ${key === active ? 'is-on' : ''}`.trim(),
        text: label,
      })));
}

function table(headers, rows) {
  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'table' }, [
      el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { text: h })))]),
      el('tbody', {}, rows.length
        ? rows
        : [el('tr', {}, [el('td', { colspan: String(headers.length), class: 'muted center', text: 'Nothing here.' })])]),
    ]),
  ]);
}

function stat(label, value, tone = '') {
  return el('div', { class: `stat ${tone}`.trim() }, [
    el('div', { class: 'stat-value', text: value }),
    el('div', { class: 'stat-label', text: label }),
  ]);
}

/** Asks for a written reason before an invasive or destructive action. */
function askReason(title, description, onConfirm, minLength = 10) {
  const input = el('textarea', { placeholder: 'Why are you doing this?' });
  const error = el('p', { class: 'error-text', hidden: true });
  const go = el('button', {
    class: 'btn btn-block', type: 'button', text: 'Confirm',
    onClick: async () => {
      const reason = input.value.trim();
      if (reason.length < minLength) {
        error.textContent = `Please give a reason of at least ${minLength} characters. It is recorded against your account.`;
        error.hidden = false;
        return;
      }
      go.disabled = true;
      try {
        await onConfirm(reason);
        panel.close();
      } catch (err) {
        error.textContent = messageFor(err);
        error.hidden = false;
        go.disabled = false;
      }
    },
  });
  const panel = sheet(title, [
    el('p', { class: 'muted', style: 'margin:0 0 .8rem', text: description }),
    input, error, el('div', { style: 'margin-top:.7rem' }, [go]),
  ]);
}

/* ---------------------------------------------------------------- sections */

async function overview() {
  showSkeleton(2);
  const [o, m] = await Promise.all([
    api.get('/api/admin/overview'),
    api.get('/api/admin/metrics'),
  ]);

  const peak = Math.max(1, ...m.days.map((d) => Math.max(d.signups, d.matches, d.messages)));
  const chart = el('div', { class: 'chart' },
    m.days.map((d) =>
      el('div', {
        class: 'chart-col',
        title: `${d.day}\nsignups ${d.signups} · matches ${d.matches} · messages ${d.messages}`,
      }, [
        el('div', { class: 'chart-bar bar-messages', style: `height:${(d.messages / peak) * 100}%` }),
        el('div', { class: 'chart-bar bar-matches', style: `height:${(d.matches / peak) * 100}%` }),
        el('div', { class: 'chart-bar bar-signups', style: `height:${(d.signups / peak) * 100}%` }),
      ])));

  mount(
    nav('overview'),
    o.urgentReports > 0
      ? card([el('div', { class: 'row row-between' }, [
          el('div', {}, [
            el('h3', { text: `${o.urgentReports} urgent report${o.urgentReports === 1 ? '' : 's'} waiting` }),
            el('p', { class: 'small muted', style: 'margin:.2rem 0 0', text: 'Threats, non-consensual imagery and suspected minors.' }),
          ]),
          el('a', { class: 'btn btn-sm', href: '#/admin/reports', text: 'Open queue' }),
        ])], 'card-accent')
      : null,
    el('div', { class: 'stats' }, [
      stat('Active users', fmt(o.activeUsers)),
      stat('Signups 24h', fmt(o.signups24h)),
      stat('Signups 7d', fmt(o.signups7d)),
      stat('Paused', fmt(o.pausedUsers)),
      stat('Deleted', fmt(o.deletedUsers)),
      stat('Profiles', fmt(o.profiles)),
      stat('Discoverable', fmt(o.discoverableProfiles)),
      stat('Open matches', fmt(o.openMatches)),
      stat('Opened', fmt(o.openedMatches)),
      stat('Messages', fmt(o.messages)),
      stat('Live posts', fmt(o.livePosts)),
      stat('Media', `${fmt(o.mediaObjects)} · ${bytes(o.mediaBytes)}`),
      stat('Open reports', fmt(o.openReports), o.openReports ? 'is-warn' : ''),
      stat('Urgent', fmt(o.urgentReports), o.urgentReports ? 'is-bad' : ''),
      stat('Open appeals', fmt(o.openAppeals)),
      stat('Clubs', fmt(o.clubs)),
      stat('Upcoming events', fmt(o.upcomingEvents)),
      stat('Live sessions', fmt(o.liveSessions)),
    ]),
    card([
      el('h2', { text: 'Last 30 days' }),
      chart,
      el('div', { class: 'legend' }, [
        el('span', { class: 'key key-signups', text: 'signups' }),
        el('span', { class: 'key key-matches', text: 'matches' }),
        el('span', { class: 'key key-messages', text: 'messages' }),
      ]),
    ]),
  );
}

async function users() {
  const search = el('input', { type: 'text', placeholder: 'Search email or display name' });
  const results = el('div');

  const load = async () => {
    results.replaceChildren(el('p', { class: 'muted small', text: 'Loading…' }));
    const { users: list } = await api.get(
      `/api/admin/users?limit=100${search.value.trim() ? `&q=${encodeURIComponent(search.value.trim())}` : ''}`);
    results.replaceChildren(
      el('p', { class: 'small muted', text: `${list.length} account${list.length === 1 ? '' : 's'}` }),
      table(['Name', 'Email', 'Status', 'Age', 'Profiles', 'Reports', 'Joined', ''],
        list.map((u) => el('tr', {}, [
          el('td', { text: u.names ?? '—' }),
          el('td', { class: 'mono', text: u.email }),
          el('td', {}, [
            el('span', {
              class: `pill ${u.status === 'active' ? 'pill-like' : u.status === 'deleted' ? 'pill-bad' : 'pill-warn'}`,
              text: u.status,
            }),
            u.isAdmin ? el('span', { class: 'pill pill-accent', text: 'admin' }) : null,
            u.isModerator ? el('span', { class: 'pill', text: 'mod' }) : null,
          ]),
          el('td', { text: String(u.age ?? '—') }),
          el('td', { text: String(u.profiles) }),
          el('td', { text: String(u.reportsAgainst) }),
          el('td', { class: 'small muted', text: when(u.createdAt) }),
          el('td', {}, [el('a', { class: 'btn btn-sm btn-ghost', href: `#/admin/user/${u.id}`, text: 'Open' })]),
        ]))),
    );
  };

  mount(nav('users'), card([
    el('div', { class: 'row' }, [
      el('div', { class: 'grow' }, [search]),
      el('button', { class: 'btn btn-sm', type: 'button', text: 'Search', onClick: load }),
    ]),
  ]), results);

  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
  await load();
}

async function userDetail(id) {
  showSkeleton(3);
  const d = await api.get(`/api/admin/users/${id}`);
  const a = d.account;

  const act = (action, label, description, danger = false, days) =>
    el('button', {
      class: `btn btn-sm ${danger ? 'btn-danger' : 'btn-ghost'}`,
      type: 'button',
      text: label,
      onClick: () => askReason(label, description, async (reason) => {
        await api.post(`/api/admin/users/${id}/action`, { action, reason, ...(days ? { days } : {}) });
        toast(`${label} done`);
        await userDetail(id);
      }, 5),
    });

  const note = el('textarea', { placeholder: 'Add an internal note' });

  mount(
    nav('users'),
    el('div', { class: 'row row-between' }, [
      el('h1', { text: d.profiles[0]?.displayName ?? a.email }),
      el('a', { class: 'btn btn-ghost btn-sm', href: '#/admin/users', text: 'Back' }),
    ]),

    card([
      el('h2', { text: 'Account' }),
      table(['Field', 'Value'], [
        ['Email', a.email], ['Status', a.status],
        ['Admin', a.isAdmin ? 'yes' : 'no'], ['Moderator', a.isModerator ? 'yes' : 'no'],
        ['Suspended until', when(a.suspendedUntil)],
        ['Identity verified', when(a.identityVerifiedAt)],
        ['Date of birth', a.dateOfBirth ?? '—'],
        ['Joined', when(a.createdAt)], ['User id', a.id],
      ].map(([k, v]) => el('tr', {}, [el('td', { text: k }), el('td', { class: 'mono', text: String(v) })]))),
      el('div', { class: 'row', style: 'margin-top:.8rem' }, [
        act('suspend', 'Suspend 7d', 'Hides their profiles and signs them out everywhere.', false, 7),
        act('reinstate', 'Reinstate', 'Restores an account to active.'),
        act('signout', 'Sign out', 'Revokes every live session for this account.'),
        act('ban', 'Ban', 'Permanent. Deletes profiles and signs them out. Moderation history is kept.', true),
      ]),
      el('div', { class: 'row', style: 'margin-top:.5rem' }, [
        a.isModerator
          ? act('revoke_moderator', 'Revoke moderator', 'Removes access to the report queue.')
          : act('grant_moderator', 'Grant moderator', 'Gives access to the report queue.'),
        a.isAdmin
          ? act('revoke_admin', 'Revoke admin', 'Removes access to this panel.', true)
          : act('grant_admin', 'Grant admin', 'Gives full access to this panel, including user data.', true),
      ]),
    ]),

    card([
      el('h2', { text: `Profiles (${d.profiles.length})` }),
      table(['Kind', 'Name', 'Visibility', 'Modes', 'Locality', 'Created'],
        d.profiles.map((p) => el('tr', {}, [
          el('td', { text: p.kind }),
          el('td', { text: p.displayName }),
          el('td', {}, [el('span', {
            class: `pill ${p.visibility === 'discoverable' ? 'pill-accent' : ''}`.trim(),
            text: p.visibility,
          })]),
          el('td', { class: 'small', text: (p.modes ?? []).join(', ') }),
          el('td', { text: p.locality ?? '—' }),
          el('td', { class: 'small muted', text: when(p.createdAt) }),
        ]))),
    ]),

    card([
      el('h2', { text: `Matches (${d.matches.length})` }),
      el('p', { class: 'small muted', text: 'Opening a conversation requires a written reason and is recorded in the access log.' }),
      table(['With', 'Messages', 'Opened', 'Secret', 'Created', ''],
        d.matches.map((m) => el('tr', {}, [
          el('td', { text: m.withName }),
          el('td', { text: String(m.messages) }),
          el('td', { class: 'small muted', text: when(m.openedAt) }),
          el('td', {}, [m.secretMode ? el('span', { class: 'pill pill-warn', text: 'E2E' }) : null]),
          el('td', { class: 'small muted', text: when(m.createdAt) }),
          el('td', {}, [el('button', {
            class: 'btn btn-sm btn-ghost', type: 'button', text: 'Read',
            onClick: () => askReason(
              'Read this conversation',
              'Both participants are recorded as subjects of this access, with your reason, permanently.',
              async (reason) => {
                const t = await api.get(`/api/admin/matches/${m.id}/messages?reason=${encodeURIComponent(reason)}`);
                sheet(`Conversation with ${m.withName}`, [
                  t.note ? el('p', { class: 'small', style: 'color:var(--warn)', text: t.note }) : null,
                  el('div', { class: 'thread' }, t.messages.length
                    ? t.messages.map((g) => el('div', { class: 'bubble' }, [
                        el('p', { class: 'small', style: 'font-weight:700;margin:0', text: g.senderName }),
                        el('p', { text: g.body }),
                        el('span', { class: 'bubble-time', text: when(g.createdAt) }),
                      ]))
                    : [el('p', { class: 'muted', text: 'No plaintext messages.' })]),
                ]);
              }),
          })]),
        ]))),
    ]),

    card([
      el('h2', { text: `Enforcement (${d.enforcement.length})` }),
      table(['Action', 'Rationale', 'Appeal', 'When'],
        d.enforcement.map((e) => el('tr', {}, [
          el('td', {}, [el('span', { class: 'pill', text: e.action })]),
          el('td', { class: 'small', text: e.rationale }),
          el('td', { text: e.appealStatus ?? '—' }),
          el('td', { class: 'small muted', text: when(e.createdAt) }),
        ]))),
    ]),

    card([
      el('h2', { text: `Reports against (${d.reportsAgainst.length})` }),
      table(['Category', 'Priority', 'Status', 'When'],
        d.reportsAgainst.map((r) => el('tr', {}, [
          el('td', { text: r.category }),
          el('td', {}, [el('span', {
            class: `pill ${r.priority === 'urgent' ? 'pill-bad' : ''}`.trim(), text: r.priority,
          })]),
          el('td', { text: r.status }),
          el('td', { class: 'small muted', text: when(r.createdAt) }),
        ]))),
    ]),

    card([
      el('h2', { text: 'Consent' }),
      table(['Type', 'Granted', 'Updated'],
        d.consents.map((c) => el('tr', {}, [
          el('td', { text: c.kind }),
          el('td', {}, [el('span', {
            class: `pill ${c.granted ? 'pill-like' : ''}`.trim(), text: c.granted ? 'yes' : 'no',
          })]),
          el('td', { class: 'small muted', text: when(c.updatedAt) }),
        ]))),
    ]),

    card([
      el('h2', { text: `Sessions (${d.sessions.length})` }),
      table(['Created', 'Expires', 'Revoked'],
        d.sessions.map((s) => el('tr', {}, [
          el('td', { class: 'small', text: when(s.createdAt) }),
          el('td', { class: 'small', text: when(s.expiresAt) }),
          el('td', { class: 'small muted', text: when(s.revokedAt) }),
        ]))),
    ]),

    card([
      el('h2', { text: 'Internal notes' }),
      note,
      el('button', {
        class: 'btn btn-sm', type: 'button', style: 'margin-top:.5rem', text: 'Add note',
        onClick: async () => {
          if (!note.value.trim()) return;
          await api.post(`/api/admin/users/${id}/notes`, { body: note.value.trim() });
          toast('Note added');
          await userDetail(id);
        },
      }),
      el('div', { style: 'margin-top:.8rem' }, [
        table(['Note', 'Author', 'When'],
          d.notes.map((n) => el('tr', {}, [
            el('td', { text: n.body }),
            el('td', { class: 'small mono', text: n.author ?? '—' }),
            el('td', { class: 'small muted', text: when(n.createdAt) }),
          ]))),
      ]),
    ]),
  );
}

async function content() {
  showSkeleton(2);
  const kind = location.hash.includes('reel') ? 'reel' : 'story';
  const { posts } = await api.get(`/api/admin/content?kind=${kind}`);
  mount(
    nav('content'),
    el('div', { class: 'row' }, [
      el('a', { class: `btn btn-sm ${kind === 'story' ? '' : 'btn-ghost'}`, href: '#/admin/content', text: 'Stories' }),
      el('a', { class: `btn btn-sm ${kind === 'reel' ? '' : 'btn-ghost'}`, href: '#/admin/content/reel', text: 'Reels' }),
    ]),
    card([table(['Author', 'Caption', 'Link', 'Hearts', 'Expires', 'State', ''],
      posts.map((p) => el('tr', {}, [
        el('td', {}, [el('a', { href: `#/admin/user/${p.authorId}`, text: p.authorName })]),
        el('td', { class: 'small', text: p.caption ?? '—' }),
        el('td', {}, [p.videoUrl
          ? el('a', { href: p.videoUrl, target: '_blank', rel: 'noopener noreferrer', class: 'small', text: 'YouTube' })
          : el('span', { class: 'small muted', text: p.mediaId ? 'photo' : '—' })]),
        el('td', { text: String(p.hearts) }),
        el('td', { class: 'small muted', text: when(p.expiresAt) }),
        el('td', {}, [p.removedAt ? el('span', { class: 'pill pill-bad', text: 'removed' }) : el('span', { class: 'pill pill-like', text: 'live' })]),
        el('td', {}, [p.removedAt ? null : el('button', {
          class: 'btn btn-sm btn-danger', type: 'button', text: 'Remove',
          onClick: () => askReason('Remove this post', 'The post is hidden from all feeds. Recorded in the audit log.', async (reason) => {
            await api.post(`/api/admin/posts/${p.id}/remove`, { reason });
            toast('Removed');
            await content();
          }, 5),
        })]),
      ])))]),
  );
}

async function clubs() {
  showSkeleton(2);
  const { clubs: list } = await api.get('/api/admin/clubs');
  mount(nav('clubs'), card([table(['Name', 'Locality', 'Members', 'Posts', 'State', ''],
    list.map((c) => el('tr', {}, [
      el('td', { text: c.name }),
      el('td', { text: c.locality ?? '—' }),
      el('td', { text: String(c.members) }),
      el('td', { text: String(c.posts) }),
      el('td', {}, [c.archivedAt ? el('span', { class: 'pill pill-bad', text: 'archived' }) : el('span', { class: 'pill pill-like', text: 'active' })]),
      el('td', {}, [c.archivedAt ? null : el('button', {
        class: 'btn btn-sm btn-danger', type: 'button', text: 'Archive',
        onClick: async () => { await api.post(`/api/admin/clubs/${c.id}/archive`); toast('Archived'); await clubs(); },
      })]),
    ])))]));
}

async function events() {
  showSkeleton(2);
  const { events: list } = await api.get('/api/admin/events');
  mount(nav('events'), card([table(['Title', 'Venue', 'Starts', 'Going', 'Capacity', 'State', ''],
    list.map((e) => el('tr', {}, [
      el('td', { text: e.title }),
      el('td', { text: e.venue ?? '—' }),
      el('td', { class: 'small', text: when(e.startsAt) }),
      el('td', { text: String(e.going) }),
      el('td', { text: e.capacity ? String(e.capacity) : '—' }),
      el('td', {}, [e.cancelledAt ? el('span', { class: 'pill pill-bad', text: 'cancelled' }) : el('span', { class: 'pill pill-like', text: 'on' })]),
      el('td', {}, [e.cancelledAt ? null : el('button', {
        class: 'btn btn-sm btn-danger', type: 'button', text: 'Cancel',
        onClick: async () => { await api.post(`/api/admin/events/${e.id}/cancel`); toast('Cancelled'); await events(); },
      })]),
    ])))]));
}

async function reports() {
  showSkeleton(3);
  const [queue, appeals] = await Promise.all([
    api.get('/api/moderation/queue'),
    api.get('/api/moderation/appeals'),
  ]);

  const decide = (r) => {
    const action = el('select');
    for (const [v, l] of [
      ['no_action', 'No action'], ['warning', 'Warning'], ['content_removed', 'Content removed'],
      ['suspended', 'Suspend'], ['banned', 'Ban'], ['reinstated', 'Reinstate'],
    ]) action.append(el('option', { value: v, text: l }));
    const rationale = el('textarea', { placeholder: 'Shown to the user. Explain the decision.' });
    const error = el('p', { class: 'error-text', hidden: true });
    const evidence = el('div');
    const panel = sheet('Decide', [
      el('p', { class: 'small muted', style: 'margin:0 0 .7rem', text: `${r.category} · ${r.priority} · reported ${when(r.createdAt)}` }),
      r.details ? el('p', { class: 'selectable', style: 'margin:0 0 .8rem', text: r.details }) : null,
      r.evidenceCount
        ? el('div', { style: 'margin-bottom:.8rem' }, [
            el('button', {
              class: 'btn btn-ghost btn-block', type: 'button',
              text: `Read the conversation (${r.evidenceCount} messages)`,
              onClick: async (event) => {
                const reason = window.prompt(
                  'Why are you reading this conversation? Recorded against your account, permanently.');
                if (!reason || reason.trim().length < 10) {
                  toast('A reason of at least 10 characters is required');
                  return;
                }
                event.currentTarget.disabled = true;
                try {
                  const e = await api.get(
                    `/api/moderation/reports/${r.id}/evidence?reason=${encodeURIComponent(reason.trim())}`);
                  evidence.replaceChildren(
                    el('p', { class: 'small', style: 'color:var(--warn);margin:.4rem 0', text: e.note }),
                    el('div', { class: 'thread' }, e.messages.map((g) =>
                      el('div', { class: `bubble ${g.senderIsSubject ? '' : 'bubble-mine'}`.trim() }, [
                        el('p', { class: 'small', style: 'font-weight:700;margin:0',
                          text: `${g.senderName}${g.senderIsSubject ? ' (reported)' : ''}` }),
                        el('p', { text: g.body }),
                        el('span', { class: 'bubble-time', text: when(g.sentAt) }),
                      ]))),
                  );
                } catch (err) {
                  toast(messageFor(err));
                  event.currentTarget.disabled = false;
                }
              },
            }),
            evidence,
          ])
        : el('p', { class: 'small muted', style: 'margin:0 0 .8rem',
            text: 'No conversation was attached to this report.' }),
      el('label', { text: 'Outcome' }), action,
      el('div', { style: 'margin-top:.6rem' }, [el('label', { text: 'Rationale' }), rationale]),
      error,
      el('button', {
        class: 'btn btn-block', type: 'button', style: 'margin-top:.7rem', text: 'Record decision',
        onClick: async () => {
          if (rationale.value.trim().length < 10) {
            error.textContent = 'A rationale of at least 10 characters is required — the user sees it.';
            error.hidden = false;
            return;
          }
          try {
            await api.post(`/api/moderation/reports/${r.id}/claim`).catch(() => {});
            await api.post(`/api/moderation/reports/${r.id}/decide`, {
              action: action.value, rationale: rationale.value.trim(), suspendDays: 7,
            });
            toast('Decision recorded');
            panel.close();
            await reports();
          } catch (err) {
            error.textContent = messageFor(err);
            error.hidden = false;
          }
        },
      }),
    ]);
  };

  mount(
    nav('reports'),
    el('div', { class: 'row' }, [
      el('span', { class: 'pill pill-bad', text: `${queue.urgent} urgent` }),
      el('span', { class: 'pill', text: `${queue.standard} standard` }),
    ]),
    card([
      el('h2', { text: 'Queue' }),
      table(['Priority', 'Category', 'Subject', 'Against', 'Evidence', 'Status', 'When', ''],
        queue.queue.map((r) => el('tr', {}, [
          el('td', {}, [el('span', { class: `pill ${r.priority === 'urgent' ? 'pill-bad' : ''}`.trim(), text: r.priority })]),
          el('td', { text: r.category }),
          el('td', {}, [el('a', { href: `#/admin/user/${r.subjectId}`, text: (r.subjectNames ?? []).join(', ') || 'account' })]),
          el('td', { text: String(r.reportsAgainstSubject) }),
          el('td', {}, [r.evidenceCount
            ? el('span', { class: 'pill pill-warn', text: `${r.evidenceCount} msg` })
            : el('span', { class: 'small muted', text: '—' })]),
          el('td', { text: r.status }),
          el('td', { class: 'small muted', text: when(r.createdAt) }),
          el('td', {}, [el('button', { class: 'btn btn-sm', type: 'button', text: 'Decide', onClick: () => decide(r) })]),
        ]))),
    ]),
    card([
      el('h2', { text: `Appeals (${appeals.appeals.length})` }),
      table(['Action', 'Their statement', 'Rationale given', 'When', ''],
        appeals.appeals.map((ap) => el('tr', {}, [
          el('td', {}, [el('span', { class: 'pill', text: ap.action })]),
          el('td', { class: 'small', text: ap.statement }),
          el('td', { class: 'small muted', text: ap.rationale }),
          el('td', { class: 'small muted', text: when(ap.createdAt) }),
          el('td', {}, [
            el('button', {
              class: 'btn btn-sm btn-ghost', type: 'button', text: 'Uphold',
              onClick: async () => { await api.post(`/api/moderation/appeals/${ap.id}/resolve`, { outcome: 'upheld' }); toast('Upheld'); await reports(); },
            }),
            el('button', {
              class: 'btn btn-sm', type: 'button', text: 'Overturn',
              onClick: async () => { await api.post(`/api/moderation/appeals/${ap.id}/resolve`, { outcome: 'overturned' }); toast('Overturned, account reinstated'); await reports(); },
            }),
          ]),
        ]))),
    ]),
  );
}

async function auditLog() {
  showSkeleton(3);
  const filter = el('input', { type: 'text', placeholder: 'Filter by action, e.g. admin. or consent.' });
  const out = el('div');
  const load = async () => {
    const { events: list } = await api.get(
      `/api/admin/audit?limit=200${filter.value.trim() ? `&action=${encodeURIComponent(filter.value.trim())}` : ''}`);
    out.replaceChildren(card([table(['When', 'Actor', 'Action', 'Subject', 'Detail'],
      list.map((e) => el('tr', {}, [
        el('td', { class: 'small muted', text: when(e.createdAt) }),
        el('td', { class: 'small mono', text: e.actor ?? 'system' }),
        el('td', {}, [el('span', { class: 'pill', text: e.action })]),
        el('td', { class: 'small mono', text: e.subject ?? '—' }),
        el('td', { class: 'small muted', text: JSON.stringify(e.metadata ?? {}) }),
      ])))]));
  };
  mount(nav('audit'), card([el('div', { class: 'row' }, [
    el('div', { class: 'grow' }, [filter]),
    el('button', { class: 'btn btn-sm', type: 'button', text: 'Filter', onClick: load }),
  ])]), out);
  filter.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
  await load();
}

async function accessLog() {
  showSkeleton(3);
  const { access } = await api.get('/api/admin/sensitive-access?limit=200');
  mount(
    nav('access'),
    card([
      el('h2', { text: 'Sensitive access' }),
      el('p', { text: 'Every time an operator reads private message content, it is recorded here with their stated reason. This log cannot be edited from the panel.' }),
    ], 'card-accent'),
    card([table(['When', 'Operator', 'Subject', 'Resource', 'Reason'],
      access.map((s) => el('tr', {}, [
        el('td', { class: 'small muted', text: when(s.createdAt) }),
        el('td', { class: 'small mono', text: s.admin ?? '—' }),
        el('td', { class: 'small mono', text: s.subject ?? '—' }),
        el('td', {}, [el('span', { class: 'pill', text: s.resource })]),
        el('td', { class: 'small', text: s.reason }),
      ])))]),
  );
}

/** Entry point. `parts` is the hash path after `#/admin`. */
export async function adminView(parts) {
  document.body.classList.add('is-admin');
  try {
    if (parts[0] === 'user' && parts[1]) return await userDetail(parts[1]);
    switch (parts[0]) {
      case 'users': return await users();
      case 'content': return await content();
      case 'clubs': return await clubs();
      case 'events': return await events();
      case 'reports': return await reports();
      case 'audit': return await auditLog();
      case 'access': return await accessLog();
      default: return await overview();
    }
  } catch (err) {
    if (err.status === 404) {
      mount(card([
        el('h3', { text: 'Not available' }),
        el('p', { text: 'This account does not have admin access.' }),
      ]));
      return;
    }
    mount(card([el('p', { class: 'error-text', text: messageFor(err) })]));
  }
}
