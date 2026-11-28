const form = document.querySelector('[data-index-search]');

if (form) {
  const input = form.querySelector('input');
  const history = window.history;
  const savedQuery = history.state?.articleSearchQuery;
  if (typeof savedQuery === 'string') input.value = savedQuery;
  const clear = form.querySelector('[data-index-search-clear]');
  const retry = form.querySelector('[data-index-search-retry]');
  const count = document.querySelector('[data-index-search-count]');
  const empty = document.querySelector('[data-index-search-empty]');
  const unavailable = document.querySelector('[data-index-search-unavailable]');
  const normalize = text => text.normalize('NFKC').trim().toLowerCase();
  const cards = Array.from(document.querySelectorAll('[data-index-search-text]'), card => ({
    card,
    id: card.dataset.indexSearchId,
    text: normalize(card.dataset.indexSearchText),
  }));
  let composing = false;
  let bodyState = 'idle';
  let bodiesById;

  async function loadBodies() {
    bodyState = 'loading';
    try {
      const url = new URL('article-search.json', import.meta.url);
      const response = await fetch(url, { cache: 'no-cache', credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw new Error('Could not load article search data');
      const bodies = await response.json();
      if (!bodies || cards.some(({ id }) => typeof bodies[id] !== 'string')) {
        throw new Error('Article search data does not match the index');
      }
      bodiesById = new Map(cards.map(({ id }) => [id, normalize(bodies[id])]));
      bodyState = 'ready';
    } catch {
      bodyState = 'unavailable';
    }
    if (!composing) filterArticles();
  }

  function filterArticles() {
    const value = input.value;
    if (value !== (history.state?.articleSearchQuery ?? '')) {
      try {
        history.replaceState({ ...history.state, articleSearchQuery: value }, '');
      } catch { /* Filtering remains usable when the browser cannot save history state. */ }
    }
    const query = normalize(value);
    const terms = query ? query.split(/\s+/) : [];
    if (query && bodyState === 'idle') void loadBodies();
    let matches = 0;
    for (const { card, id, text } of cards) {
      const body = bodiesById?.get(id) ?? '';
      card.hidden = !terms.every(term => text.includes(term) || body.includes(term));
      if (!card.hidden) matches += 1;
    }
    const loading = Boolean(query) && bodyState === 'loading';
    const label = loading ? '本文を検索中' : `${matches}件`;
    if (count.textContent !== label) count.textContent = label;
    empty.hidden = loading || matches !== 0;
    unavailable.hidden = !query || bodyState !== 'unavailable';
    clear.disabled = input.value.length === 0;
  }

  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => {
    composing = false;
    filterArticles();
  });
  input.addEventListener('input', event => {
    if (!composing && !event.isComposing) filterArticles();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!composing) filterArticles();
  });
  clear.addEventListener('click', () => {
    input.value = '';
    input.focus();
    filterArticles();
  });
  if (retry) {
    retry.hidden = false;
    retry.addEventListener('click', () => {
      if (bodyState !== 'unavailable' || composing) return;
      // The retry button is hidden while loading. Keep focus in the search section.
      if (document.activeElement === retry) count.focus({ preventScroll: true });
      void loadBodies();
      filterArticles();
    });
  }
  filterArticles();
  form.hidden = false;
}
