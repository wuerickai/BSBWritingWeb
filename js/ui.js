// Small DOM helper library — no framework, just ergonomic element creation.

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in node && k !== 'list') { try { node[k] = v; } catch { node.setAttribute(k, v); } }
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

export function option(value, label, selected = false) {
  return el('option', { value, text: label, selected });
}

export function fillSelect(select, items, { value = (x) => x, label = (x) => x, selected = null, placeholder = null } = {}) {
  clear(select);
  if (placeholder != null) select.appendChild(el('option', { value: '', text: placeholder, disabled: false, selected: selected == null }));
  for (const it of items) {
    const v = value(it);
    select.appendChild(option(v, label(it), selected != null && String(selected) === String(v)));
  }
}

let toastTimer = null;
export function toast(message, kind = 'info') {
  let host = document.getElementById('toast-host');
  if (!host) { host = el('div', { id: 'toast-host' }); document.body.appendChild(host); }
  const t = el('div', { class: `toast toast-${kind}`, text: message });
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3800);
}

// Simple modal with custom content. Returns { close, box }.
export function modal(title, contentNode, { wide = false, onClose = null } = {}) {
  const overlay = el('div', { class: 'modal-overlay' });
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    overlay.remove();
    document.removeEventListener('keydown', esc);
    if (onClose) { try { onClose(); } catch {} }
  };
  function esc(ev) { if (ev.key === 'Escape') close(); }
  const box = el('div', { class: 'modal-box' + (wide ? ' modal-wide' : '') }, [
    el('div', { class: 'modal-head' }, [
      el('h3', { text: title }),
      el('button', { class: 'icon-btn', text: '✕', title: 'Close', onclick: close }),
    ]),
    el('div', { class: 'modal-body' }, [contentNode]),
  ]);
  overlay.appendChild(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', esc);
  document.body.appendChild(overlay);
  return { close, box };
}

export function confirmDialog(message, { confirmText = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    const body = el('div', {}, [
      el('p', { text: message, style: 'margin:0 0 18px' }),
      el('div', { class: 'row-end' }, [
        el('button', { class: 'btn ghost', text: 'Cancel', onclick: () => { m.close(); resolve(false); } }),
        el('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), text: confirmText, onclick: () => { m.close(); resolve(true); } }),
      ]),
    ]);
    const m = modal('Please confirm', body);
  });
}

export function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export const STATE_META = {
  draft: { label: 'Draft', cls: 'st-draft' },
  in_review: { label: 'In review', cls: 'st-review' },
  changes_requested: { label: 'Changes requested', cls: 'st-changes' },
  finalized: { label: 'Finalized', cls: 'st-final' },
};

export function stateBadge(state) {
  const m = STATE_META[state] || { label: state, cls: '' };
  return el('span', { class: 'badge ' + m.cls, text: m.label });
}

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
