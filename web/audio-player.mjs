export const AUDIO_RATES = Object.freeze([0.8, 1, 1.2, 1.5, 2, 2.5, 3]);
const HASH = /^[a-f0-9]{64}$/;

function invalid(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function secureUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch { return null; }
}

function manifestLocation(value, pageUrl) {
  const url = secureUrl(value), page = secureUrl(pageUrl);
  if (!url || !page || url.origin !== page.origin || !url.pathname.endsWith('/audio/index.json') || url.search || url.hash) invalid('manifest-url');
  return url;
}

/** Reject stale article audio and paths outside this site's audio directory. */
export function validateAudioManifest(manifest, {manifestUrl, pageUrl, articleId, articleTitle, articleHash}) {
  const location = manifestLocation(manifestUrl, pageUrl);
  const match = /^(\d{4}-\d{2}-\d{2})-[123]$/.exec(articleId || '');
  if (!match || !HASH.test(articleHash || '') || manifest?.version !== 1) invalid('manifest-format');
  const date = match[1], day = manifest.days?.[date], voice = manifest.voice;
  if (!day) invalid('missing-day');
  if (!voice || ['name', 'credit', 'licenseTitle', 'licenseUrl', 'sourceUrl'].some(key => typeof voice[key] !== 'string' || !voice[key].trim())) invalid('voice-credit');
  if (!secureUrl(voice.licenseUrl) || !secureUrl(voice.sourceUrl)) invalid('voice-credit');
  if (typeof day.url !== 'string' || !new RegExp(`^${date}-[a-f0-9]{12}\\.mp3$`).test(day.url) || !HASH.test(day.sha256 || '') || !day.url.endsWith(`-${day.sha256.slice(0, 12)}.mp3`)) invalid('audio-url');
  const audioUrl = new URL(day.url, location);
  if (audioUrl.protocol !== 'https:' || audioUrl.origin !== location.origin || audioUrl.pathname !== location.pathname.replace(/index\.json$/, day.url) || audioUrl.search || audioUrl.hash) invalid('audio-url');
  if (!Number.isFinite(day.duration) || day.duration <= 0 || !Array.isArray(day.articles) || day.articles.length !== 3) invalid('audio-chapters');
  let previousEnd = 0;
  const articles = day.articles.map((article, index) => {
    if (article?.id !== `${date}-${index + 1}` || typeof article.title !== 'string' || !article.title.trim() || !HASH.test(article.articleHash || '') || !Number.isFinite(article.start) || !Number.isFinite(article.end) || article.start < 0 || article.end <= article.start || article.start < previousEnd - 0.001 || article.end > day.duration + 0.001) invalid('audio-chapters');
    if (index === 0 && article.start !== 0) invalid('audio-chapters');
    previousEnd = article.end;
    return {...article};
  });
  if (Math.abs(previousEnd - day.duration) > 0.001) invalid('audio-chapters');
  const currentIndex = articles.findIndex(article => article.id === articleId);
  if (currentIndex < 0 || articles[currentIndex].title !== articleTitle || articles[currentIndex].articleHash !== articleHash) invalid('content-mismatch');
  return {date, voice: {...voice}, day: {...day, url: audioUrl.href, articles}, currentIndex};
}

export function formatAudioTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function audioChapterAt(articles, position) {
  let index = 0;
  for (let i = 0; i < articles.length; i += 1) {
    // Browsers round media positions; a seek to a chapter may land just below it.
    if (position + 0.001 >= articles[i].start) index = i;
  }
  return index;
}

/** Every daily view must match the audio, including articles other than the opened one. */
export function validateAudioArticleViews(articles, views, pageUrl) {
  const page = secureUrl(pageUrl);
  if (!page || !Array.isArray(views) || views.length !== articles.length) invalid('article-views');
  const byId = new Map();
  for (const view of views) {
    if (!view || byId.has(view.id)) invalid('article-views');
    byId.set(view.id, view);
  }
  for (const article of articles) {
    const view = byId.get(article.id), url = secureUrl(view?.url);
    if (!view || view.articleHash !== article.articleHash || view.title !== article.title || !url || url.origin !== page.origin || url.href !== new URL(`${article.id}.html`, page).href) invalid('content-mismatch');
  }
  return byId;
}

/** Timings come from synthesized PCM frames; mismatched or absent text is never highlighted. */
export function matchingAudioCues(article, cueTexts) {
  if (!Array.isArray(article.cues) || !article.cues.length) return [];
  const texts = cueTexts instanceof Map ? cueTexts : new Map(Object.entries(cueTexts || {}));
  const keys = new Set(); let previousEnd = article.start;
  for (const cue of article.cues) {
    if (!cue || !/^(?:title|section-\d+|paragraph-\d+|action-heading|action)$/.test(cue.key || '') || keys.has(cue.key) || typeof cue.text !== 'string' || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.end <= cue.start || Math.abs(cue.start - previousEnd) > 0.001 || cue.end > article.end + 0.001) return [];
    keys.add(cue.key); previousEnd = cue.end;
  }
  if (Math.abs(previousEnd - article.end) > 0.001) return [];
  const normalized = text => String(text).replace(/\r\n?/g, '\n');
  return article.cues.filter(cue => texts.has(cue.key) && normalized(texts.get(cue.key)) === normalized(cue.text));
}

export function audioCueAt(cues, position) {
  if (!Number.isFinite(position)) return null;
  // An omitted text match leaves a real gap rather than extending a neighboring cue.
  return cues.find(cue => position + 0.001 >= cue.start && position + 0.001 < cue.end) || null;
}

/** A manual figure choice lasts for this article; automatic choice follows its paragraphs. */
export function audioFigureIndex(figures, cueKey, selection = 'auto') {
  if (!figures.length || selection === 'none') return -1;
  if (Number.isInteger(selection) && selection >= 0 && selection < figures.length) return selection;
  const match = /^(?:paragraph|section)-(\d+)$/.exec(cueKey || '');
  const paragraph = match ? Number(match[1]) : /^action(?:-heading)?$/.test(cueKey || '') ? Infinity : -1;
  let index = 0;
  figures.forEach((figure, candidate) => { if (figure.afterParagraph <= paragraph) index = candidate; });
  return index;
}

/** Pausing preserves the view; closing it remains a choice until this playback session ends. */
export function audioListeningState(previous, phase, action) {
  if (action === 'open') return {active: true, dismissed: false};
  if (action === 'close') return {active: false, dismissed: true};
  if (['idle', 'finished', 'error'].includes(phase)) return {active: false, dismissed: false};
  if (['loading', 'playing'].includes(phase) && !previous.dismissed) return {active: true, dismissed: false};
  return {...previous};
}

function cleanListeningClone(node) {
  const clone = node.cloneNode(true);
  for (const item of [clone, ...clone.querySelectorAll('*')]) {
    for (const name of ['id', 'data-speech-chunk', 'data-audio-cue', 'aria-current', 'aria-labelledby', 'aria-describedby']) item.removeAttribute(name);
    if (item.tagName === 'IMG') item.removeAttribute('style');
    item.classList.remove('audio-reading-active');
  }
  return clone;
}

/** Figure markup comes only from the already parsed, version-matched article snapshots. */
function articleListeningFigures(content) {
  const sources = [...content.querySelectorAll('.source-figure')].filter(figure => figure.querySelector('img[src]')).slice(0, 2);
  const figures = sources.length ? sources : [...content.querySelectorAll('.story-visual')].filter(figure => figure.querySelector('img[src]')).slice(0, 1);
  return figures.map(figure => {
    let previous = figure.previousElementSibling;
    while (previous && !/^paragraph-\d+$/.test(previous.dataset.audioCue || '')) previous = previous.previousElementSibling;
    return {node: figure, afterParagraph: Number(previous?.dataset.audioCue?.split('-')[1] || 0)};
  });
}

/** This view never moves, replaces, starts, pauses, or seeks the native media element. */
function createListeningView({doc, win, player, listen, onFollow, onLocate}) {
  const make = (tag, className, text) => {
    const node = doc.createElement(tag); node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const button = (text, className, handler) => {
    const node = make('button', className, text); node.type = 'button'; listen(node, 'click', handler); return node;
  };
  const panel = make('section', 'audio-listening-view'); panel.dataset.audioListeningView = ''; panel.hidden = true;
  panel.setAttribute('aria-label', '図と本文を見ながら聴く');
  const toolbar = make('div', 'audio-listening-toolbar');
  const title = make('p', 'audio-listening-title');
  const close = button('記事を読む', 'audio-listening-close', () => setMode('close'));
  toolbar.append(title, close);
  const content = make('div', 'audio-listening-content');
  const figurePane = make('section', 'audio-listening-figure-pane'); figurePane.setAttribute('aria-label', 'この記事の図');
  const figureControls = make('div', 'audio-listening-figure-controls');
  const choices = make('div', 'audio-listening-figure-choices'); choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', '表示する図');
  const zoomButton = button('全体を表示', 'audio-listening-zoom-button', () => {
    const expanded = stage.classList.toggle('is-zoomed');
    zoomButton.textContent = expanded ? '全体を表示' : '図を拡大'; zoomButton.setAttribute('aria-pressed', String(expanded));
    stage.scrollTop = 0; stage.scrollLeft = 0;
  });
  figureControls.append(choices, zoomButton);
  const stage = make('div', 'audio-listening-figure-stage'); stage.tabIndex = 0;
  stage.setAttribute('aria-label', '図。拡大表示では上下にスクロールできます');
  const figureDetails = make('details', 'audio-listening-figure-details');
  figureDetails.append(make('summary', '', '図の説明・出典'));
  const description = make('div', 'audio-listening-figure-description');
  const expandButton = button('別画面で拡大', 'audio-listening-expand-button', () => openZoom());
  figureDetails.append(description, expandButton);
  figurePane.append(figureControls, stage, figureDetails);
  const readingPane = make('section', 'audio-listening-reading-pane'); readingPane.setAttribute('aria-label', '読み上げ中の本文');
  const readingControls = make('div', 'audio-listening-reading-controls');
  const followLabel = make('label', 'audio-listening-follow');
  const follow = doc.createElement('input'); follow.type = 'checkbox'; follow.checked = true;
  followLabel.append(follow, doc.createTextNode(' 本文を自動で追う'));
  listen(follow, 'change', () => onFollow(follow.checked));
  const locate = button('再生位置へ', 'audio-listening-locate', () => onLocate());
  readingControls.append(followLabel, locate);
  const reading = make('div', 'audio-listening-reading'); reading.tabIndex = 0; reading.setAttribute('aria-label', '本文。自動追従を外すと自由にスクロールできます');
  readingPane.append(readingControls, reading); content.append(figurePane, readingPane); panel.append(toolbar, content); doc.body.append(panel);
  const open = button('図と本文', 'audio-listening-open', () => setMode('open')); open.dataset.audioListeningOpen = '';
  open.setAttribute('aria-label', '図と本文を表示'); open.setAttribute('aria-expanded', 'false');
  const existingFollowControls = player.querySelector('.audio-follow-controls');
  if (existingFollowControls) existingFollowControls.append(open); else player.append(open);
  player.classList.add('audio-listening-player');
  const zoom = make('dialog', 'audio-listening-zoom'); zoom.setAttribute('aria-label', '図の拡大と出典');
  const zoomToolbar = make('div', 'audio-listening-zoom-toolbar');
  const zoomTitle = make('h2', 'audio-listening-zoom-title', '図の拡大');
  const zoomClose = button('閉じる', 'audio-listening-zoom-close', () => closeZoom());
  const zoomContent = make('div', 'audio-listening-zoom-content'); zoomContent.tabIndex = 0;
  zoomToolbar.append(zoomTitle, zoomClose); zoom.append(zoomToolbar, zoomContent); doc.body.append(zoom);
  let mode = {active: false, dismissed: false}, phase = 'idle', articleId = null, figures = [], selection = 'auto', figureIndex = -2;
  let cueNodes = new Map(), currentCue = null, savedFocus = null, savedScroll = null, inertNodes = [], inertSeen = new Set();
  let lastCueKey = null, lastView = null, lastFollow = true, disposed = false;
  function viewport() {
    if (!mode.active) return;
    const viewport = win.visualViewport;
    doc.body.style.setProperty('--audio-viewport-height', `${viewport?.height || win.innerHeight || doc.documentElement.clientHeight}px`);
    doc.body.style.setProperty('--audio-viewport-offset-top', `${viewport?.offsetTop || 0}px`);
    const height = player.getBoundingClientRect().height;
    if (height) doc.body.style.setProperty('--audio-listening-player-height', `${Math.ceil(height)}px`);
  }
  const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(viewport) : null;
  observer?.observe(player);
  listen(win, 'resize', viewport); listen(win.visualViewport, 'resize', viewport); listen(win.visualViewport, 'scroll', viewport);
  function focus(node) { if (doc.visibilityState !== 'hidden') try { node?.focus({preventScroll: true}); } catch { node?.focus(); } }
  function restrictBackground() {
    const visit = node => {
      if (node === panel || node === player || node === zoom) return;
      if (node.contains(player)) { [...node.children].forEach(visit); return; }
      if (inertSeen.has(node)) return;
      inertSeen.add(node);
      inertNodes.push([node, node.hasAttribute('inert')]); node.setAttribute('inert', '');
    };
    [...doc.body.children].forEach(visit);
  }
  function applyMode(next) {
    const changed = mode.active !== next.active; mode = next;
    if (!changed || disposed) return;
    panel.hidden = !mode.active; doc.body.classList.toggle('is-audio-listening', mode.active);
    open.setAttribute('aria-expanded', String(mode.active));
    if (mode.active) {
      savedFocus = doc.activeElement; savedScroll = [win.scrollX || 0, win.scrollY || 0];
      restrictBackground(); viewport(); focus(close); scrollReading();
    } else {
      closeZoom();
      inertNodes.forEach(([node, wasInert]) => { if (!wasInert) node.removeAttribute('inert'); }); inertNodes = []; inertSeen = new Set();
      const target = savedFocus?.isConnected && savedFocus !== doc.body ? savedFocus : open;
      focus(target);
      if (savedScroll && doc.visibilityState !== 'hidden') win.scrollTo?.({left: savedScroll[0], top: savedScroll[1], behavior: 'instant'});
      savedFocus = null; savedScroll = null;
    }
  }
  function setMode(action) { applyMode(audioListeningState(mode, phase, action)); }
  function closeZoom() {
    if (!zoom.open) return;
    if (typeof zoom.close === 'function') zoom.close(); else { zoom.removeAttribute('open'); zoom.hidden = true; }
  }
  function watchImages(container) {
    container.querySelectorAll('img').forEach(image => {
      image.loading = 'eager';
      const failed = () => {
        if (!image.isConnected || image.hidden) return;
        image.hidden = true;
        const note = make('p', 'audio-listening-empty', '図を読み込めません。図の説明・出典から内容を確認できます。');
        image.parentNode.append(note);
      };
      image.addEventListener('error', failed, {once: true});
      if (image.complete && image.naturalWidth === 0) failed();
    });
  }
  function openZoom() {
    if (figureIndex < 0) return;
    zoomContent.replaceChildren(cleanListeningClone(figures[figureIndex].node));
    zoomTitle.textContent = `${lastView?.title || ''}：図${figureIndex + 1}`;
    watchImages(zoomContent);
    if (typeof zoom.showModal === 'function') zoom.showModal(); else { zoom.hidden = false; zoom.setAttribute('open', ''); }
    focus(zoomClose);
  }
  listen(zoom, 'click', event => { if (event.target === zoom) closeZoom(); });
  listen(zoom, 'close', () => { if (mode.active) focus(figureDetails.open ? expandButton : figureIndex >= 0 ? zoomButton : close); });
  function showFigure(cueKey) {
    const index = audioFigureIndex(figures, cueKey, selection);
    choices.querySelectorAll('button').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.selection === String(selection))));
    if (index === figureIndex) return;
    figureIndex = index; stage.replaceChildren(); description.replaceChildren();
    content.classList.toggle('is-figure-hidden', index < 0); stage.hidden = index < 0;
    zoomButton.disabled = index < 0; figureDetails.hidden = index < 0;
    stage.classList.add('is-zoomed'); stage.scrollTop = 0; stage.scrollLeft = 0;
    zoomButton.textContent = '全体を表示'; zoomButton.setAttribute('aria-pressed', 'true');
    if (index < 0) {
      stage.append(make('p', 'audio-listening-empty', figures.length ? '図を隠しています。本文を読みながら聴けます。' : 'この記事には表示できる図がありません。本文を読みながら聴けます。'));
      return;
    }
    const figure = cleanListeningClone(figures[index].node), image = figure.querySelector('img');
    stage.append(image);
    figure.querySelectorAll('figcaption, .figure-commentary, .figure-note, .visual-legend').forEach(node => description.append(node));
    watchImages(stage);
    if (zoom.open) { closeZoom(); focus(zoomButton); }
  }
  function showArticle(view) {
    articleId = view.id; lastView = view; figures = view.figures; selection = 'auto'; figureIndex = -2; lastCueKey = null;
    closeZoom(); figureDetails.open = false; title.textContent = view.title; panel.dataset.articleId = view.id;
    if (mode.active) restrictBackground();
    choices.replaceChildren();
    zoomButton.hidden = !figures.length;
    const options = figures.length > 1 ? [['自動', 'auto'], ...figures.map((_, index) => [`図${index + 1}`, index]), ['図なし', 'none']] : figures.length ? [['図を表示', 'auto'], ['図なし', 'none']] : [];
    options.forEach(([label, value]) => {
      const choice = button(label, '', () => { selection = value; showFigure(lastCueKey); });
      choice.dataset.selection = String(value); choices.append(choice);
    });
    if (!figures.length) choices.append(make('span', 'audio-listening-empty', 'この記事には図がありません'));
    reading.replaceChildren(); cueNodes = new Map(); currentCue = null;
    for (const [key, source] of view.cueNodes) {
      const node = cleanListeningClone(source); node.classList.add('audio-listening-cue'); node.dataset.listeningCue = key;
      cueNodes.set(key, node); reading.append(node);
    }
    if (!cueNodes.size) reading.append(make('p', 'audio-listening-empty', '同期できる本文がありません。「記事を読む」から本文を確認できます。'));
    reading.scrollTop = 0; showFigure(null);
  }
  function scrollReading(force = false) {
    if (!mode.active || !currentCue || (!lastFollow && !force) || doc.visibilityState === 'hidden') return;
    const box = reading.getBoundingClientRect(), cue = currentCue.getBoundingClientRect();
    if (cue.top >= box.top + 8 && cue.top < box.bottom - 30 && (cue.height > box.height - 16 || cue.bottom <= box.bottom - 8)) return;
    reading.scrollTo?.({top: Math.max(0, reading.scrollTop + cue.top - box.top - 12), behavior: force || win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
  }
  listen(doc, 'keydown', event => {
    if (!mode.active || zoom.open) return;
    if (event.key === 'Escape') { event.preventDefault(); setMode('close'); return; }
    if (event.key !== 'Tab') return;
    const selector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]';
    const nodes = [...player.querySelectorAll(selector), ...panel.querySelectorAll(selector)].filter(node => !node.closest('[hidden]') && node.getClientRects().length);
    const index = nodes.indexOf(doc.activeElement), next = event.shiftKey ? index - 1 : index + 1;
    if (index < 0 || next < 0 || next >= nodes.length) { event.preventDefault(); focus(nodes[event.shiftKey ? nodes.length - 1 : 0]); }
  });
  return {
    get active() { return mode.active; },
    update(state, view, cue, enabled, force = false) {
      phase = state.phase; lastFollow = enabled;
      if (articleId !== view.id) showArticle(view);
      follow.checked = enabled; follow.disabled = !view.cues.length; locate.disabled = !cue;
      const node = cue ? cueNodes.get(cue.key) : null, changed = node !== currentCue;
      if (changed) {
        currentCue?.classList.remove('audio-listening-cue-current'); currentCue?.removeAttribute('aria-current');
        currentCue = node;
        if (node) { node.classList.add('audio-listening-cue-current'); node.setAttribute('aria-current', 'true'); }
      }
      lastCueKey = cue?.key || null; showFigure(lastCueKey);
      applyMode(audioListeningState(mode, phase));
      if (force || (changed && state.phase === 'playing')) scrollReading(force);
      viewport();
    },
    refresh() { viewport(); scrollReading(); },
    dispose() {
      applyMode({active: false, dismissed: false}); disposed = true; observer?.disconnect();
      panel.remove(); zoom.remove(); open.remove(); player.classList.remove('audio-listening-player');
      for (const name of ['--audio-viewport-height', '--audio-viewport-offset-top', '--audio-listening-player-height']) doc.body.style.removeProperty(name);
    },
  };
}

function prepareArticleViews(doc, win, articles) {
  const root = doc.querySelector('[data-audio-article-root]');
  const activeHeader = root?.querySelector('[data-audio-article-header]');
  const activeContent = root?.querySelector('[data-audio-article-content]');
  if (!root || !activeHeader || !activeContent) invalid('article-views');
  function viewFrom(node, header, content) {
    if (!header || !content) invalid('article-views');
    return {
      id: node.dataset.articleId, articleHash: node.dataset.audioContentHash,
      title: header.querySelector('h1[data-speech-chunk]')?.textContent,
      url: node.dataset.articleUrl, documentTitle: node.dataset.documentTitle,
      description: node.dataset.description,
      header: header.cloneNode(true), content: content.cloneNode(true),
    };
  }
  const views = [viewFrom(root, activeHeader, activeContent)];
  doc.querySelectorAll('template[data-audio-article-template]').forEach(template => {
    views.push(viewFrom(template, template.content.querySelector('[data-audio-article-header]'), template.content.querySelector('[data-audio-article-content]')));
  });
  const byId = validateAudioArticleViews(articles, views, win.location.href);
  for (const article of articles) {
    const view = byId.get(article.id), texts = new Map();
    view.cueNodes = new Map();
    for (const part of [view.header, view.content]) {
      part.querySelectorAll('[data-audio-cue]').forEach(node => { texts.set(node.dataset.audioCue, node.textContent); view.cueNodes.set(node.dataset.audioCue, node); });
    }
    view.cues = matchingAudioCues(article, texts);
    view.figures = articleListeningFigures(view.content);
  }
  let currentId = root.dataset.articleId;
  return {
    root, byId,
    current() { return currentId; },
    show(id) {
      if (id === currentId) return;
      const view = byId.get(id);
      if (!view) invalid('article-views');
      root.querySelector('[data-audio-article-header]').replaceWith(view.header.cloneNode(true));
      root.querySelector('[data-audio-article-content]').replaceWith(view.content.cloneNode(true));
      root.dataset.articleId = id; root.dataset.audioContentHash = view.articleHash;
      root.dataset.articleUrl = view.url; root.dataset.documentTitle = view.documentTitle;
      root.dataset.description = view.description;
      doc.title = view.documentTitle;
      doc.querySelector('meta[name="description"]')?.setAttribute('content', view.description || view.title);
      try { win.history.replaceState(win.history.state, '', view.url); } catch { /* The visible article still changes when History is unavailable. */ }
      currentId = id;
    },
  };
}

/** One media element and one daily file keep chapter transitions independent of JS timers. */
export function createAudioReader({audio, articles, duration, startIndex = 0, onChange = () => {}}) {
  let phase = 'idle', rate = 1, error = null, generation = 0, intendedPlaying = false;
  let pendingSeek = articles[startIndex].start, metadataValid = false, disposed = false;
  const listeners = [];
  const listen = (name, handler) => {
    audio.addEventListener(name, handler);
    listeners.push(() => audio.removeEventListener(name, handler));
  };
  const position = () => pendingSeek ?? (Number.isFinite(audio.currentTime) ? audio.currentTime : articles[startIndex].start);
  const state = () => {
    const actualRate = Number.isFinite(audio.playbackRate) ? audio.playbackRate : null;
    return {phase, rate, actualRate, rateUnavailable: actualRate !== rate, error, position: position(), duration, index: audioChapterAt(articles, position())};
  };
  const emit = () => { if (!disposed) onChange(state()); };
  let syncingRate = false, rateRepairsLeft = 2;
  let reportedRate = rate, reportedActualRate = audio.playbackRate;
  const rejectedRates = new Map();
  const nativeRateMatches = () => audio.playbackRate === rate &&
    (audio.defaultPlaybackRate === rate || rejectedRates.get('defaultPlaybackRate') === rate);
  function reportRate() {
    if (reportedRate === rate && Object.is(reportedActualRate, audio.playbackRate)) return;
    reportedRate = rate; reportedActualRate = audio.playbackRate; emit();
  }
  function syncRate({rateEvent = false} = {}) {
    if (disposed || syncingRate) return;
    if (!rateEvent) { rateRepairsLeft = 2; rejectedRates.clear(); }
    const properties = ['defaultPlaybackRate', 'playbackRate'].filter(property =>
      audio[property] !== rate && rejectedRates.get(property) !== rate);
    if (!properties.length || (rateEvent && rateRepairsLeft <= 0)) { reportRate(); return; }
    if (rateEvent) rateRepairsLeft -= 1;
    syncingRate = true;
    try {
      for (const property of properties) {
        try {
          audio[property] = rate;
          if (audio[property] !== rate) rejectedRates.set(property, rate);
        } catch { rejectedRates.set(property, rate); }
      }
    } finally { syncingRate = false; }
    // Some engines clamp or reject a rate. Do not create a ratechange write loop.
    // A later explicit checkpoint or stable timeupdate allows a fresh recovery.
    reportRate();
  }
  function verifyMetadata() {
    if (!Number.isFinite(audio.duration) || Math.abs(audio.duration - duration) > 0.5) invalid('duration-mismatch');
    metadataValid = true;
  }
  function applySeek() {
    if (pendingSeek === null || !metadataValid) return;
    audio.currentTime = pendingSeek;
    pendingSeek = null;
  }
  function fail(code) {
    if (disposed) return;
    generation += 1; intendedPlaying = false; phase = 'error'; error = code || 'audio-error';
    audio.pause(); emit();
  }
  function metadata() {
    if (audio.readyState >= 1) {
      try { verifyMetadata(); return Promise.resolve(); } catch (failure) { return Promise.reject(failure); }
    }
    return new Promise((resolve, reject) => {
      let timer;
      const done = (failure) => {
        clearTimeout(timer);
        audio.removeEventListener('loadedmetadata', loaded);
        audio.removeEventListener('error', failed);
        if (failure) reject(failure); else resolve();
      };
      const loaded = () => { try { verifyMetadata(); done(); } catch (failure) { done(failure); } };
      const failed = () => done(new Error('audio-error'));
      audio.addEventListener('loadedmetadata', loaded);
      audio.addEventListener('error', failed);
      timer = setTimeout(() => done(new Error('audio-timeout')), 20000);
    });
  }
  async function play() {
    if (disposed) return;
    syncRate();
    if (intendedPlaying) return;
    const retrying = phase === 'error';
    if (phase === 'finished') pendingSeek = articles[startIndex].start;
    const token = ++generation;
    intendedPlaying = true; phase = 'loading'; error = null;
    if (retrying) { pendingSeek = position(); metadataValid = false; audio.load(); }
    emit();
    try {
      await metadata();
      if (disposed || token !== generation) return;
      applySeek(); syncRate();
      await audio.play();
      if (disposed || token !== generation) return;
      phase = audio.paused ? 'paused' : 'playing';
      if (audio.paused) intendedPlaying = false;
      emit();
    } catch (failure) {
      if (disposed || token !== generation) return;
      intendedPlaying = false;
      if (failure.name === 'NotAllowedError') {
        phase = 'paused'; error = 'play-blocked'; emit();
      } else if (failure.name === 'AbortError') {
        phase = 'paused'; error = null; emit();
      } else fail(failure.code === 'duration-mismatch' ? failure.code : failure.message === 'audio-timeout' ? 'audio-timeout' : 'audio-error');
    }
  }
  function pause() {
    if (disposed) return;
    generation += 1; intendedPlaying = false; audio.pause();
    if (phase !== 'idle') phase = 'paused';
    error = null; emit();
  }
  function seekTo(value) {
    if (disposed || !Number.isFinite(Number(value))) return;
    pendingSeek = Math.max(0, Math.min(duration, Number(value)));
    try { applySeek(); } catch { fail('seek-error'); return; }
    if (phase === 'finished') phase = 'paused';
    emit();
  }
  function select(index, {startPlayback = false} = {}) {
    if (!Number.isInteger(index) || index < 0 || index >= articles.length) return;
    seekTo(articles[index].start);
    if (startPlayback) void play();
  }
  listen('ratechange', () => syncRate({rateEvent: true}));
  listen('loadedmetadata', () => {
    syncRate();
    try { verifyMetadata(); applySeek(); emit(); } catch (failure) { fail(failure.code || 'seek-error'); }
  });
  listen('playing', () => {
    if (!intendedPlaying) { audio.pause(); return; }
    syncRate();
    phase = 'playing'; error = null; emit();
  });
  listen('pause', () => {
    if (phase === 'playing' || phase === 'loading') { generation += 1; intendedPlaying = false; phase = 'paused'; emit(); }
  });
  listen('waiting', () => { if (intendedPlaying) { phase = 'loading'; emit(); } });
  listen('timeupdate', () => {
    if (nativeRateMatches()) { rateRepairsLeft = 2; rejectedRates.delete('playbackRate'); }
    emit();
  });
  listen('seeked', () => { syncRate(); emit(); });
  listen('ended', () => { generation += 1; intendedPlaying = false; phase = 'finished'; error = null; emit(); });
  listen('error', () => fail('audio-error'));
  return {
    state, play, pause, seekTo, select, syncRate,
    next() { select(state().index + 1); },
    previous() { select(state().index - 1); },
    restart() { select(state().index); },
    stop() {
      if (disposed) return;
      generation += 1; intendedPlaying = false; audio.pause();
      phase = 'idle'; error = null; seekTo(articles[startIndex].start);
    },
    setRate(value) {
      const next = Number(value);
      if (!AUDIO_RATES.includes(next)) return;
      rate = next; syncRate(); emit();
    },
    dispose() { generation += 1; intendedPlaying = false; disposed = true; audio.pause(); listeners.forEach(remove => remove()); },
  };
}

function audioErrorMessage(code) {
  if (code === 'play-blocked') return 'ブラウザが再生を保留しました。「再開」を押すと、この位置から聴けます。';
  if (code === 'duration-mismatch') return '音声ファイルの長さが記事情報と一致しません。再試行するか、端末の読み上げに切り替えてください。';
  if (code === 'audio-timeout') return '音声の読み込みに時間がかかっています。通信状態を確認して再試行してください。';
  return '音声ファイルを再生できませんでした。通信状態を確認して再試行するか、端末の読み上げに切り替えてください。';
}

/** The fallback is loaded only after validation fails, or an explicit user choice. */
export async function initAudioPlayer(doc = globalThis.document, win = globalThis.window) {
  const player = doc?.querySelector('[data-speech-player]');
  if (!player || player.dataset.audioReady) return null;
  player.dataset.audioReady = 'true'; player.hidden = false;
  const find = selector => player.querySelector(selector);
  const toggle = find('[data-speech-toggle]'), stop = find('[data-speech-stop]');
  const speed = find('[data-speech-rate]'), progress = find('[data-speech-progress]');
  const status = find('[data-speech-status]'), audio = find('[data-audio-element]');
  const current = find('[data-audio-current]'), time = find('[data-audio-time]'), seek = find('[data-audio-seek]');
  const previous = find('[data-audio-previous]'), next = find('[data-audio-next]'), restart = find('[data-audio-restart]');
  const chapters = find('[data-audio-chapters]'), credit = find('[data-audio-credit]');
  const fallbackButton = find('[data-audio-use-fallback]'), fallbackReason = find('[data-audio-fallback-reason]');
  const follow = find('[data-audio-follow]'), locate = find('[data-audio-locate]');
  const syncStatus = find('[data-audio-sync-status]');
  if (!toggle || !stop || !speed || !progress || !status || !audio) return null;
  let reader = null, fallbackStarted = false, clearReading = () => {}, listeningView = null;
  const cleanups = [];
  const listen = (node, name, handler) => {
    node?.addEventListener(name, handler);
    if (node) cleanups.push(() => node.removeEventListener(name, handler));
  };
  async function fallback(reason) {
    if (fallbackStarted) return;
    fallbackStarted = true; reader?.dispose(); listeningView?.dispose(); cleanups.forEach(remove => remove()); clearReading();
    audio.removeAttribute('src'); audio.load();
    player.querySelectorAll('[data-audio-only]').forEach(node => { node.hidden = true; });
    if (fallbackButton) fallbackButton.hidden = true;
    progress.hidden = false;
    player.dataset.speechFallback = 'true';
    const help = find('#speech-help');
    if (help) help.textContent = '代替の端末読み上げでは、いま表示している記事だけを読み上げます。段落の強調表示は使えません。再開は止めた部分の先頭から。画面をロックすると停止する場合があります。';
    const details = find('.audio-details');
    if (details) details.open = true;
    if (fallbackReason) { fallbackReason.hidden = false; fallbackReason.textContent = reason; }
    toggle.disabled = false; speed.disabled = false;
    try {
      const fallbackUrl = new URL(player.dataset.audioFallback, win.location.href);
      if (fallbackUrl.origin !== win.location.origin || fallbackUrl.protocol !== 'https:' || !fallbackUrl.pathname.endsWith('/speech.js')) throw new Error('fallback-url');
      const speech = await import(fallbackUrl.href);
      speech.initSpeechPlayer(doc, win);
    } catch {
      toggle.disabled = true; stop.disabled = true; speed.disabled = true;
      status.textContent = '音声と代替読み上げを読み込めませんでした。通信状態を確認し、ページを開き直してください。';
    }
  }
  let edition, articleViews;
  try {
    const location = manifestLocation(player.dataset.audioManifest, win.location.href);
    const request = new URL(location);
    request.searchParams.set('article', player.dataset.audioContentHash || '');
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 12000);
    let manifest;
    try {
      const response = await win.fetch(request.href, {cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', signal: abort.signal});
      if (!response.ok) throw new Error('manifest-fetch');
      manifest = await response.json();
    }
    finally { clearTimeout(timer); }
    edition = validateAudioManifest(manifest, {
      manifestUrl: location.href, pageUrl: win.location.href,
      articleId: player.dataset.articleId,
      articleTitle: doc.querySelector('h1[data-speech-chunk]')?.textContent,
      articleHash: player.dataset.audioContentHash,
    });
    articleViews = prepareArticleViews(doc, win, edition.day.articles);
    if (!audio.canPlayType('audio/mpeg')) throw new Error('audio-unsupported');
  } catch (failure) {
    const reason = ['content-mismatch', 'article-views'].includes(failure.code) ? '同じ日の本文と音声の版を一致させられないため、表示中の記事を端末の読み上げで聴けます。' : failure.code === 'missing-day' ? 'この日の音声ファイルがないため、端末の読み上げを使います。' : '音声ファイルの情報を取得・確認できないため、端末の読み上げを使います。';
    await fallback(reason);
    return null;
  }
  const {day, voice, date, currentIndex} = edition;
  player.querySelectorAll('[data-audio-only]').forEach(node => { node.hidden = false; });
  progress.hidden = true;
  if (seek) seek.max = String(day.duration);
  const chapterButtons = day.articles.map((article, index) => {
    const item = doc.createElement('li'), button = doc.createElement('button');
    button.type = 'button'; button.textContent = `${index + 1}. ${article.title}`;
    button.setAttribute('aria-label', `${index + 1}本目を聴く：${article.title}`);
    listen(button, 'click', () => reader?.select(index, {startPlayback: true}));
    item.append(button); chapters?.append(item);
    return button;
  });
  if (credit) {
    credit.append(doc.createTextNode(`音声：${voice.name} / ${voice.credit}。音声モデルの出力をMP3に変換した合成音声です。 `));
    for (const [text, href] of [[voice.licenseTitle, voice.licenseUrl], ['音声モデルの出典', voice.sourceUrl]]) {
      const link = doc.createElement('a'); link.textContent = text; link.href = href;
      link.target = '_blank'; link.rel = 'noopener noreferrer'; credit.append(link, doc.createTextNode(' '));
    }
  }
  let followEnabled = true, highlighted = null, lastReadingId = null, lastCueKey = null, lastReadingPhase = null;
  try { followEnabled = win.localStorage.getItem('ai-daily-audio-follow') !== 'off'; } catch { /* Optional preference. */ }
  if (follow) follow.checked = followEnabled;
  clearReading = () => {
    if (highlighted) { highlighted.classList.remove('audio-reading-active'); highlighted.removeAttribute('aria-current'); }
    highlighted = null; lastReadingId = null; lastCueKey = null; lastReadingPhase = null;
  };
  function setFollow(value) {
    followEnabled = value;
    if (follow) follow.checked = value;
    try { win.localStorage.setItem('ai-daily-audio-follow', value ? 'on' : 'off'); } catch { /* Optional preference. */ }
    if (reader) syncReading(reader.state(), value);
  }
  listeningView = createListeningView({doc, win, player, listen, onFollow: setFollow, onLocate: () => syncReading(reader.state(), true)});
  function scrollToReading(node) {
    if (!node || doc.visibilityState === 'hidden') return;
    const rectangle = node.getBoundingClientRect(), toolbar = player.getBoundingClientRect();
    const height = win.innerHeight || doc.documentElement.clientHeight;
    const top = toolbar.top <= 24 || rectangle.top >= toolbar.bottom ? Math.min(toolbar.height + 24, height - 80) : 24;
    const available = Math.max(80, height - top - 24);
    if (rectangle.top >= top && (rectangle.height > available ? rectangle.top < height - 24 : rectangle.bottom <= height - 24)) return;
    const offset = rectangle.top - top - Math.max(0, (available - rectangle.height) / 2);
    const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    try { win.scrollBy({top: offset, behavior: reduced ? 'instant' : 'smooth'}); } catch { node.scrollIntoView?.({block: 'center'}); }
  }
  function syncReading(state, forceScroll = false) {
    const article = day.articles[state.index];
    if (articleViews.current() !== article.id) clearReading();
    articleViews.show(article.id);
    const view = articleViews.byId.get(article.id), cue = audioCueAt(view.cues, state.position);
    const changed = lastReadingId !== article.id || lastCueKey !== cue?.key || (state.phase === 'playing' && lastReadingPhase !== 'playing');
    const showHighlight = cue && (forceScroll || !['idle', 'finished', 'error'].includes(state.phase));
    const node = showHighlight ? articleViews.root.querySelector(`[data-audio-cue="${cue.key}"]`) : null;
    if (node !== highlighted) {
      if (highlighted) { highlighted.classList.remove('audio-reading-active'); highlighted.removeAttribute('aria-current'); }
      highlighted = node;
      if (node) { node.classList.add('audio-reading-active'); node.setAttribute('aria-current', 'true'); }
    }
    if (follow) follow.disabled = !view.cues.length;
    if (locate) locate.disabled = !cue;
    if (syncStatus) syncStatus.textContent = !view.cues.length ? 'この音声には本文と一致する段落の時刻情報がないため、記事の切り替えだけを行います。' : view.cues.length < (article.cues?.length || 0) ? '本文と時刻情報が一致する段落だけを強調表示します。' : '実際に合成した音声の時刻に合わせて、読み上げ中の見出しや段落を強調表示します。';
    listeningView.update(state, view, cue, followEnabled, forceScroll);
    if (!listeningView.active && node && (forceScroll || (followEnabled && changed && state.phase === 'playing'))) scrollToReading(node);
    lastReadingId = article.id; lastCueKey = cue?.key; lastReadingPhase = state.phase;
  }
  let lastIndex = -1, lastStatus = '';
  const session = win.navigator?.mediaSession;
  function update(state) {
    const article = day.articles[state.index];
    syncReading(state);
    toggle.disabled = false;
    toggle.textContent = state.phase === 'playing' || state.phase === 'loading' ? '一時停止' : state.phase === 'paused' ? '再開' : state.phase === 'finished' ? 'もう一度聴く' : state.phase === 'error' ? 'もう一度試す' : '再生';
    stop.disabled = state.phase === 'idle'; speed.value = String(state.rate);
    if (previous) previous.disabled = state.index === 0;
    if (next) next.disabled = state.index === day.articles.length - 1;
    if (seek) seek.value = String(state.position);
    if (time) time.textContent = `${formatAudioTime(state.position)} / ${formatAudioTime(state.duration)}`;
    if (fallbackButton) fallbackButton.hidden = state.phase !== 'error';
    let message = '「再生」を押すと、この記事からその日の残りの記事を続けて聴けます。';
    if (state.phase === 'loading') message = '音声を読み込んでいます。';
    if (state.phase === 'playing') message = `${state.index + 1}本目を再生中。`;
    if (state.phase === 'paused') message = state.error ? audioErrorMessage(state.error) : '一時停止中。「再開」で同じ位置から聴けます。';
    if (state.phase === 'finished') message = 'この日の最後の記事まで再生しました。';
    if (state.phase === 'error') message = audioErrorMessage(state.error);
    if (state.rateUnavailable) message += state.actualRate === null ? ' 再生速度を確認できません。速度を選び直してください。' : ` 設定は${state.rate}倍速ですが、実際の再生速度は${state.actualRate}倍速です。速度を選び直してください。`;
    if (message !== lastStatus) { status.textContent = message; lastStatus = message; }
    if (state.index !== lastIndex) {
      if (current) current.textContent = `${state.index + 1} / 3　${article.title}`;
      chapterButtons.forEach((button, index) => { if (index === state.index) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current'); });
      if (session && typeof win.MediaMetadata === 'function') {
        try { session.metadata = new win.MediaMetadata({title: article.title, artist: 'あなたの朝の3本', album: `${date}の3本`}); } catch { /* Optional OS controls. */ }
      }
      lastIndex = state.index;
    }
    if (session) {
      try {
        session.playbackState = state.phase === 'playing' || state.phase === 'loading' ? 'playing' : state.phase === 'idle' || state.phase === 'finished' ? 'none' : 'paused';
        if (Number.isFinite(audio.duration) && audio.duration > 0) session.setPositionState?.({duration: audio.duration, playbackRate: state.rate, position: Math.min(audio.duration, Math.max(0, state.position))});
      } catch { /* Media Session support varies by browser. */ }
    }
  }
  reader = createAudioReader({audio, articles: day.articles, duration: day.duration, startIndex: currentIndex, onChange: update});
  listen(toggle, 'click', () => ['playing', 'loading'].includes(reader.state().phase) ? reader.pause() : void reader.play());
  listen(stop, 'click', () => reader.stop());
  listen(previous, 'click', () => reader.previous());
  listen(next, 'click', () => reader.next());
  listen(restart, 'click', () => reader.restart());
  listen(seek, 'change', () => reader.seekTo(Number(seek.value)));
  listen(follow, 'change', () => {
    setFollow(follow.checked);
  });
  listen(locate, 'click', () => syncReading(reader.state(), true));
  listen(doc, 'visibilitychange', () => {
    if (doc.visibilityState === 'hidden') return;
    reader.syncRate();
    // Hidden timeupdates can advance the cue without moving the visible page.
    lastReadingId = null; lastCueKey = null; lastReadingPhase = null;
    update(reader.state());
    listeningView.refresh();
  });
  listen(win, 'pageshow', () => reader.syncRate());
  listen(speed, 'change', () => {
    reader.setRate(speed.value);
    try { win.localStorage.setItem('ai-daily-speech-rate', String(reader.state().rate)); } catch { /* Optional preference. */ }
  });
  listen(fallbackButton, 'click', () => void fallback('音声ファイルから、この記事の端末読み上げに切り替えました。'));
  if (session) {
    const actions = {
      play: () => void reader.play(), pause: () => reader.pause(), stop: () => reader.stop(),
      nexttrack: () => reader.next(), previoustrack: () => reader.previous(),
      seekbackward: details => reader.seekTo(reader.state().position - (details.seekOffset || 10)),
      seekforward: details => reader.seekTo(reader.state().position + (details.seekOffset || 10)),
      seekto: details => reader.seekTo(details.seekTime),
    };
    for (const [action, handler] of Object.entries(actions)) {
      try { session.setActionHandler(action, handler); cleanups.push(() => { try { session.setActionHandler(action, null); } catch { /* Optional action. */ } }); } catch { /* Optional action. */ }
    }
    cleanups.push(() => { try { session.playbackState = 'none'; session.metadata = null; session.setPositionState?.(); } catch { /* Optional OS controls. */ } });
  }
  try { const stored = Number(win.localStorage.getItem('ai-daily-speech-rate')); if (AUDIO_RATES.includes(stored)) reader.setRate(stored); } catch { /* Optional preference. */ }
  update(reader.state());
  audio.src = day.url; audio.load();
  return reader;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') void initAudioPlayer();
