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
  const state = () => ({phase, rate, error, position: position(), duration, index: audioChapterAt(articles, position())});
  const emit = () => { if (!disposed) onChange(state()); };
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
    if (disposed || intendedPlaying) return;
    const retrying = phase === 'error';
    if (phase === 'finished') pendingSeek = articles[startIndex].start;
    const token = ++generation;
    intendedPlaying = true; phase = 'loading'; error = null;
    if (retrying) { pendingSeek = position(); metadataValid = false; audio.load(); }
    emit();
    try {
      await metadata();
      if (disposed || token !== generation) return;
      applySeek(); audio.playbackRate = rate;
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
  listen('loadedmetadata', () => {
    try { verifyMetadata(); applySeek(); emit(); } catch (failure) { fail(failure.code || 'seek-error'); }
  });
  listen('playing', () => {
    if (!intendedPlaying) { audio.pause(); return; }
    phase = 'playing'; error = null; emit();
  });
  listen('pause', () => {
    if (phase === 'playing' || phase === 'loading') { generation += 1; intendedPlaying = false; phase = 'paused'; emit(); }
  });
  listen('waiting', () => { if (intendedPlaying) { phase = 'loading'; emit(); } });
  listen('timeupdate', emit);
  listen('seeked', emit);
  listen('ended', () => { generation += 1; intendedPlaying = false; phase = 'finished'; error = null; emit(); });
  listen('error', () => fail('audio-error'));
  return {
    state, play, pause, seekTo, select,
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
      rate = next; audio.playbackRate = next; emit();
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
  if (!toggle || !stop || !speed || !progress || !status || !audio) return null;
  let reader = null, fallbackStarted = false;
  const cleanups = [];
  const listen = (node, name, handler) => {
    node?.addEventListener(name, handler);
    if (node) cleanups.push(() => node.removeEventListener(name, handler));
  };
  async function fallback(reason) {
    if (fallbackStarted) return;
    fallbackStarted = true; reader?.dispose(); cleanups.forEach(remove => remove());
    audio.removeAttribute('src'); audio.load();
    player.querySelectorAll('[data-audio-only]').forEach(node => { node.hidden = true; });
    if (fallbackButton) fallbackButton.hidden = true;
    progress.hidden = false;
    player.dataset.speechFallback = 'true';
    const help = find('#speech-help');
    if (help) help.textContent = '代替の端末読み上げでは、開いている記事だけを読み上げます。再開は止めた部分の先頭から。画面をロックすると停止する場合があります。';
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
  let edition;
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
    if (!audio.canPlayType('audio/mpeg')) throw new Error('audio-unsupported');
  } catch (failure) {
    const reason = failure.code === 'content-mismatch' ? '本文と音声の版が一致しないため、端末の読み上げを使います。' : failure.code === 'missing-day' ? 'この日の音声ファイルがないため、端末の読み上げを使います。' : '音声ファイルの情報を取得・確認できないため、端末の読み上げを使います。';
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
  let lastIndex = -1, lastStatus = '';
  const session = win.navigator?.mediaSession;
  function update(state) {
    const article = day.articles[state.index];
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
