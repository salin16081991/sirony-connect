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
