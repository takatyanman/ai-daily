const form = document.querySelector('[data-index-search]');

if (form) {
  const input = form.querySelector('input');
  const clear = form.querySelector('[data-index-search-clear]');
  const count = document.querySelector('[data-index-search-count]');
  const empty = document.querySelector('[data-index-search-empty]');
  const normalize = text => text.normalize('NFKC').trim().toLowerCase();
  const cards = Array.from(document.querySelectorAll('[data-index-search-text]'), card => ({
    card,
    text: normalize(card.dataset.indexSearchText),
  }));
  let composing = false;

  function filterArticles() {
    const query = normalize(input.value);
    let matches = 0;
    for (const { card, text } of cards) {
      card.hidden = !text.includes(query);
      if (!card.hidden) matches += 1;
    }
    const label = `${matches}件`;
    if (count.textContent !== label) count.textContent = label;
    empty.hidden = matches !== 0;
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
