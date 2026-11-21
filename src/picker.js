// Selector de pantalla. Los nombres de las ventanas vienen del sistema: se pintan como texto.
const screensEl = document.getElementById('screens');
const windowsEl = document.getElementById('windows');

function empty(text) {
  const d = document.createElement('div');
  d.className = 'empty';
  d.textContent = text;
  return d;
}

function card(source) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'src';
  b.dataset.sourceId = source.id;
  b.title = source.name;
  if (typeof source.thumbnail === 'string' && source.thumbnail.startsWith('data:image/')) {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = '';
    img.src = source.thumbnail;
    b.appendChild(img);
  }
  const n = document.createElement('span');
  n.className = 'name';
  n.textContent = source.name || (source.kind === 'screen' ? 'Pantalla' : 'Ventana');
  b.appendChild(n);
  b.addEventListener('click', () => window.displayPicker.choose(source.id));
  return b;
}

window.displayPicker.onSources((list) => {
  const sources = Array.isArray(list) ? list : [];
  const screens = sources.filter((s) => s.kind === 'screen');
  const windows = sources.filter((s) => s.kind !== 'screen');
  screensEl.replaceChildren(...(screens.length ? screens.map(card) : [empty('No hay pantallas disponibles.')]));
  windowsEl.replaceChildren(...(windows.length ? windows.map(card) : [empty('No hay ventanas disponibles.')]));
  const first = document.querySelector('.src');
  if (first) first.focus();
});

document.getElementById('cancel').addEventListener('click', () => window.displayPicker.cancel());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.displayPicker.cancel(); });
