/**
 * Tinder/Bumble-style card deck.
 *
 * Pointer Events rather than touch events, so the same code drives finger,
 * mouse and stylus. The gesture is deliberately forgiving: a short flick
 * commits on velocity even if the card never crosses the distance threshold,
 * which is what makes it feel native rather than like a drag-and-drop widget.
 */

const THRESHOLD = 0.28; // fraction of card width that commits a decision
const FLICK_VELOCITY = 0.55; // px/ms — a quick flick commits regardless
const MAX_ROTATION = 14; // degrees at full travel

export function createDeck({ container, cards, onDecide, onEmpty, renderCard }) {
  let index = 0;
  const state = { pointerId: null, startX: 0, startY: 0, dx: 0, dy: 0, startedAt: 0 };
  let active = null;
  let locked = false;

  function layout() {
    container.replaceChildren();
    if (index >= cards.length) {
      onEmpty?.();
      return;
    }

    // Render at most three: the live card plus two peeking behind it. Any more
    // is invisible and just costs layout.
    const visible = cards.slice(index, index + 3).reverse();
    for (const [offset, card] of visible.entries()) {
      const depth = visible.length - 1 - offset;
      const node = renderCard(card);
      node.classList.add('swipe-card');
      node.style.setProperty('--depth', String(depth));
      node.dataset.depth = String(depth);
      if (depth === 0) {
        node.classList.add('is-active');
        attach(node, card);
      } else {
        node.setAttribute('aria-hidden', 'true');
      }
      container.append(node);
    }
    active = container.querySelector('.is-active');
  }

  function attach(node, card) {
    const like = node.querySelector('[data-stamp="like"]');
    const nope = node.querySelector('[data-stamp="nope"]');

    const move = (event) => {
      if (state.pointerId !== event.pointerId) return;
      state.dx = event.clientX - state.startX;
      state.dy = event.clientY - state.startY;

      // Vertical drag is damped: this deck decides on the horizontal axis, and
      // letting cards fly upward competes with page scrolling.
      const damped = state.dy * 0.35;
      const ratio = state.dx / node.offsetWidth;
      node.style.transform =
        `translate3d(${state.dx}px, ${damped}px, 0) rotate(${ratio * MAX_ROTATION}deg)`;
      if (like) like.style.opacity = String(Math.max(0, Math.min(1, ratio / THRESHOLD)));
      if (nope) nope.style.opacity = String(Math.max(0, Math.min(1, -ratio / THRESHOLD)));
    };

    const end = (event) => {
      if (state.pointerId !== event.pointerId) return;
      node.releasePointerCapture?.(event.pointerId);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', end);
      node.removeEventListener('pointercancel', end);
      state.pointerId = null;
      node.classList.remove('is-dragging');

      const elapsed = Math.max(1, performance.now() - state.startedAt);
      const velocity = state.dx / elapsed;
      const ratio = state.dx / node.offsetWidth;
      const commit =
        Math.abs(ratio) > THRESHOLD || Math.abs(velocity) > FLICK_VELOCITY;

      if (commit) {
        fling(node, card, state.dx > 0 ? 'like' : 'pass');
      } else {
        node.classList.add('is-returning');
        node.style.transform = '';
        if (like) like.style.opacity = '0';
        if (nope) nope.style.opacity = '0';
        setTimeout(() => node.classList.remove('is-returning'), 260);
      }
      state.dx = 0;
      state.dy = 0;
    };

    node.addEventListener('pointerdown', (event) => {
      if (locked || state.pointerId !== null) return;
      // Let buttons and links inside the card work normally.
      if (event.target.closest('button, a')) return;
      state.pointerId = event.pointerId;
      state.startX = event.clientX;
      state.startY = event.clientY;
      state.startedAt = performance.now();
      node.setPointerCapture?.(event.pointerId);
      node.classList.add('is-dragging');
      node.addEventListener('pointermove', move);
      node.addEventListener('pointerup', end);
      node.addEventListener('pointercancel', end);
    });
  }

  function fling(node, card, decision) {
    if (locked) return;
    locked = true;
    const direction = decision === 'like' ? 1 : -1;
    node.classList.add('is-leaving');
    node.style.transform =
      `translate3d(${direction * (window.innerWidth + 200)}px, ${state.dy * 0.4}px, 0) rotate(${direction * 22}deg)`;
    node.style.opacity = '0';

    // Advance as the animation finishes rather than waiting for it, so rapid
    // decisions still feel immediate.
    setTimeout(() => {
      index += 1;
      locked = false;
      layout();
    }, 220);

    void onDecide?.(decision, card);
  }

  layout();

  return {
    /** Drives the on-screen buttons, so they animate identically to a swipe. */
    decide(decision) {
      if (!active || locked) return;
      const card = cards[index];
      if (!card) return;
      state.dy = 0;
      fling(active, card, decision);
    },
    rewind() {
      if (index === 0 || locked) return false;
      index -= 1;
      layout();
      return true;
    },
    get remaining() {
      return Math.max(0, cards.length - index);
    },
  };
}
