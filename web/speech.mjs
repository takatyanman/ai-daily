const RATES = new Set([0.8, 1, 1.2, 1.5]);

/** Short utterances; preserve punctuation and Unicode surrogate pairs. */
export function splitForSpeech(value, limit = 160) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  const parts = []; let current = '', count = 0;
  for (const character of text) {
    current += character; count += 1;
    if (count >= limit || /[。！？!?]/u.test(character)) {
      if (current.trim()) parts.push(current.trim());
      current = ''; count = 0;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function japaneseVoice(synth) {
  const voices = Array.from(synth.getVoices?.() || []);
  const ja = voices.filter(v => /^ja(?:[-_]|$)/iu.test(v.lang || ''));
  return { voice: ja.find(v => v.localService && v.default) || ja.find(v => v.localService) || ja.find(v => v.default) || ja[0], missing: voices.length > 0 && ja.length === 0 };
}

/** Android pause stops speech: retain the current sentence and cancel safely. */
export function createSpeechReader({ synth, Utterance, segments, onChange = () => {} }) {
  const chunks = segments.map(value => String(value).trim()).filter(Boolean);
  let phase = 'idle', index = 0, rate = 1, error = null, started = false;
  let generation = 0, active = null;
  const state = () => ({ phase, index, total: chunks.length, rate, error, started });
  const emit = () => onChange(state());
  function cancel() {
    generation += 1; active = null; started = false;
    try { synth.cancel(); } catch { /* Engine errors are reported by play. */ }
  }
  function fail(code) { cancel(); phase = 'error'; error = code || 'synthesis-failed'; emit(); }
  function speakCurrent() {
    if (phase !== 'playing') return;
    if (index >= chunks.length) { active = null; phase = 'finished'; started = false; emit(); return; }
    let selected;
    try { selected = japaneseVoice(synth); } catch { fail('voice-unavailable'); return; }
    if (selected.missing) { fail('language-unavailable'); return; }
    const token = generation;
    const utterance = new Utterance(chunks[index]);
    utterance.lang = 'ja-JP'; utterance.rate = rate;
    if (selected.voice) utterance.voice = selected.voice;
    active = utterance;
    const current = () => token === generation && active === utterance && phase === 'playing';
    utterance.onstart = () => { if (current()) { started = true; emit(); } };
    utterance.onend = () => { if (current()) { active = null; index += 1; emit(); speakCurrent(); } };
    utterance.onerror = event => {
      if (!current()) return;
      if (event.error === 'interrupted' || event.error === 'canceled') {
        cancel(); phase = 'paused'; error = 'interrupted'; emit();
      } else fail(event.error);
    };
    emit();
    try { synth.speak(utterance); } catch { if (current()) fail('synthesis-failed'); }
  }
  return {
    state,
    play() {
      if (phase === 'playing' || !chunks.length) return;
      if (phase === 'finished' || phase === 'idle') index = 0;
      cancel(); phase = 'playing'; error = null; speakCurrent();
    },
    pause() { if (phase === 'playing') { cancel(); phase = 'paused'; error = null; emit(); } },
    stop() { cancel(); phase = 'idle'; index = 0; error = null; emit(); },
    setRate(value) {
      const next = Number(value);
      if (!RATES.has(next) || next === rate) return;
      const restart = phase === 'playing';
      if (restart) cancel();
      rate = next; emit();
      if (restart) speakCurrent();
    },
  };
}

function errorMessage(code) {
  if (code === 'language-unavailable' || code === 'voice-unavailable') return '日本語の音声が見つかりません。端末の読み上げ設定で日本語音声を選び、ページを開き直してください。';
  if (code === 'not-allowed') return '読み上げを開始できませんでした。もう一度ボタンを押すか、Chromeなどのブラウザで記事を開いてください。';
  if (code === 'network') return '音声を取得できませんでした。通信状態と端末の音声設定を確認して、もう一度お試しください。';
  if (code === 'audio-busy' || code === 'audio-hardware') return '音声を再生できませんでした。ほかの音声再生と端末の音量・出力先を確認して、もう一度お試しください。';
  return '読み上げを開始できませんでした。端末の音声設定を確認するか、Chromeなど別のブラウザでお試しください。';
}

export function initSpeechPlayer(doc = globalThis.document, win = globalThis.window) {
  const player = doc?.querySelector('[data-speech-player]');
  if (!player || player.dataset.speechReady) return null;
  player.dataset.speechReady = 'true';
  const toggle = player.querySelector('[data-speech-toggle]'), stop = player.querySelector('[data-speech-stop]');
  const speed = player.querySelector('[data-speech-rate]'), progress = player.querySelector('[data-speech-progress]');
  const status = player.querySelector('[data-speech-status]');
  if (!toggle || !stop || !speed || !progress || !status) return null;
  player.hidden = false;
  const supported = win?.speechSynthesis && typeof win.SpeechSynthesisUtterance === 'function';
  const segments = Array.from(doc.querySelectorAll('[data-speech-chunk]')).flatMap(node => splitForSpeech(node.textContent));
  if (!supported || !segments.length) {
    toggle.disabled = true; stop.disabled = true; speed.disabled = true;
    status.textContent = supported ? '読み上げる本文がありません。' : 'このブラウザでは音声読み上げを使えません。Chromeなどの対応ブラウザで記事を開いてください。';
    return null;
  }
  let lastStatus = '';
  function update(state) {
    toggle.disabled = false;
    toggle.textContent = state.phase === 'playing' ? '一時停止' : state.phase === 'paused' ? '再開' : state.phase === 'finished' ? 'もう一度聴く' : state.phase === 'error' ? 'もう一度試す' : '読み上げる';
    stop.disabled = state.phase === 'idle'; speed.value = String(state.rate);
    progress.max = state.total || 1; progress.value = state.index;
    progress.setAttribute('aria-valuetext', `${state.index} / ${state.total}`);
    let message = '「読み上げる」を押すと、タイトルと本文を読み上げます。';
    if (state.phase === 'playing') message = state.started ? '読み上げ中。' : '音声を準備しています。';
    if (state.phase === 'paused') message = state.error === 'interrupted' ? '読み上げが中断されました。「再開」で止めた部分の先頭から聴けます。' : '一時停止中。再開すると、止めた部分の先頭から読み上げます。';
    if (state.phase === 'finished') message = '最後まで読み上げました。';
    if (state.phase === 'error') message = errorMessage(state.error);
    if (message !== lastStatus) { status.textContent = message; lastStatus = message; }
  }
  const reader = createSpeechReader({ synth: win.speechSynthesis, Utterance: win.SpeechSynthesisUtterance, segments, onChange: update });
  try { const stored = Number(win.localStorage.getItem('ai-daily-speech-rate')); if (RATES.has(stored)) reader.setRate(stored); } catch { /* Optional preference. */ }
  update(reader.state());
  toggle.addEventListener('click', () => reader.state().phase === 'playing' ? reader.pause() : reader.play());
  stop.addEventListener('click', () => reader.stop());
  speed.addEventListener('change', () => {
    reader.setRate(speed.value);
    try { win.localStorage.setItem('ai-daily-speech-rate', String(reader.state().rate)); } catch { /* Storage may be disabled. */ }
  });
  // Resolve voices anew on every play: an initially empty getVoices() list is not cached.
  win.addEventListener('pagehide', () => reader.stop());
  return reader;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') initSpeechPlayer();
