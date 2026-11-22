const form = document.querySelector('[data-index-search]');

if (form) {
  const input = form.querySelector('input');
  const clear = form.querySelector('[data-index-search-clear]');
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
    const query = normalize(input.value);
    if (query && bodyState === 'idle') void loadBodies();
    let matches = 0;
    for (const { card, id, text } of cards) {
      card.hidden = !text.includes(query) && !bodiesById?.get(id)?.includes(query);
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
  filterArticles();
  form.hidden = false;
}
