/** Tiny DOM helpers. No framework, no build step — the CSP forbids inline
 *  script, so everything here binds listeners programmatically. */

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function field(labelText, input, hint) {
  return el('div', { class: 'field' }, [
    el('label', { text: labelText, for: input.id || undefined }),
    input,
    hint ? el('p', { class: 'hint', text: hint }) : null,
  ]);
}

export function card(children, extraClass = '') {
  return el('section', { class: `card ${extraClass}`.trim() }, children);
}

let toastTimer;
export function toast(message) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 3200);
}

export function mount(...children) {
  const view = document.getElementById('view');
  view.replaceChildren(...children.filter(Boolean));
  window.scrollTo(0, 0);
}

/** Multi-select chip group. Returns a node plus a getter for the selection. */
export function chipGroup(options, selected = []) {
  const chosen = new Set(selected);
  const wrap = el('div', { class: 'chips' });
  for (const [value, label] of options) {
    const chip = el('button', {
      type: 'button',
      class: 'chip',
      text: label,
      'aria-pressed': chosen.has(value) ? 'true' : 'false',
      onClick: () => {
        if (chosen.has(value)) chosen.delete(value);
        else chosen.add(value);
        chip.setAttribute('aria-pressed', chosen.has(value) ? 'true' : 'false');
      },
    });
    wrap.append(chip);
  }
  return { node: wrap, value: () => [...chosen] };
}

/** Explicit confirmation for irreversible actions. */
export function confirmAction(message) {
  return window.confirm(message);
}

/* ------------------------------------------------- interaction primitives -- */

/**
 * Short haptic tick. Android fires it; iOS Safari ignores `vibrate` entirely,
 * so this is a progressive enhancement and never a requirement.
 */
export function haptic(pattern = 12) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported — nothing to do */
  }
}

/** Placeholder blocks shown while a screen loads, instead of a blank pane. */
export function skeleton(rows = 3) {
  return el('div', { class: 'stack' },
    Array.from({ length: rows }, () =>
      el('div', { class: 'skeleton-card' }, [
        el('div', { class: 'skeleton skeleton-avatar' }),
        el('div', { class: 'grow' }, [
          el('div', { class: 'skeleton skeleton-line', style: 'width:55%' }),
          el('div', { class: 'skeleton skeleton-line', style: 'width:80%' }),
        ]),
      ])));
}

export function showSkeleton(rows) {
  mount(skeleton(rows));
}

/**
 * Bottom sheet — the mobile-native way to show secondary detail without
 * losing the page behind it. Dismissed by backdrop tap, the close button,
 * or Escape.
 */
export function sheet(title, children) {
  const panel = el('div', { class: 'sheet-panel', role: 'dialog', 'aria-modal': 'true' }, [
    el('div', { class: 'sheet-grip' }),
    el('div', { class: 'row row-between', style: 'margin-bottom:.6rem' }, [
      el('h2', { text: title, style: 'font-size:1.15rem' }),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Close', onClick: () => close() }),
    ]),
    ...[].concat(children),
  ]);

  const backdrop = el('div', { class: 'sheet-backdrop', onClick: (e) => {
    if (e.target === backdrop) close();
  } }, [panel]);

  function close() {
    backdrop.classList.add('is-closing');
    setTimeout(() => backdrop.remove(), 180);
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  return { close };
}

/** Remembers one-off UI hints so a coach mark shows once, not every visit. */
export const seen = {
  has: (key) => {
    try { return localStorage.getItem(`seen:${key}`) === '1'; } catch { return true; }
  },
  mark: (key) => {
    try { localStorage.setItem(`seen:${key}`, '1'); } catch { /* private mode */ }
  },
};
