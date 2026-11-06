import {createHash} from 'node:crypto';
import {articleIllustrationPath, renderArticleThumbnailSvg} from './illustrations.mjs';

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const escapeAttribute = escapeHtml;
// Change with the audio UI so newly rendered pages bypass older browser assets.
const AUDIO_UI_REVISION = '20261107-figure-listening';

function absolute(path, baseUrl) {
  return new URL(path, baseUrl).href;
}

function articleUrl(article, baseUrl) {
  return absolute(`articles/${encodeURIComponent(String(article.id))}.html`, baseUrl);
}

function dateInfo(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    iso: date.toISOString(),
    date: new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
    }).format(date),
    time: new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(date),
  };
}

function publishedDate(value, { showTime = false } = {}) {
  const date = dateInfo(value);
  if (!date) return '';
  return `<time datetime="${escapeAttribute(date.iso)}">${escapeHtml(date.date)}${showTime ? ` ${escapeHtml(date.time)} JST` : ''}</time>`;
}

function sourceUrl(value) {
  try {
    const url = new URL(String(value));
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** Only explicitly supported, public image origins may be embedded in a quoted figure. */
export function figureImageUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    const host = url.hostname;
    if (host === 'takatyanman.github.io') {
      return /^\/ai-daily\/figures\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(?:png|jpe?g|webp)$/.test(url.pathname) && !url.search ? url.href : null;
    }
    return host === 'jreast.co.jp' || host.endsWith('.jreast.co.jp') ||
      host === 'prtimes.jp' || host.endsWith('.prtimes.jp') || host === 'prcdn.freetls.fastly.net' || host === 'upload.wikimedia.org' || host === 'thumb.wikimedia.org' ? url.href : null;
  } catch {
    return null;
  }
}

export function localFigureFilename(value) {
  const safe = figureImageUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  return url.hostname === 'takatyanman.github.io' ? url.pathname.slice('/ai-daily/figures/'.length) : null;
}

function secureSourceUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url.href : null;
  } catch {
    return null;
  }
}

/** The explanatory text is deliberately adjacent to, and separate from, the quoted material. */
export function renderSourceFigures(article, after) {
  const figures = Array.isArray(article?.reading?.figures) ? article.reading.figures.slice(0, 2) : [];
  const sources = new Set((Array.isArray(article.sources) ? article.sources : []).map(source => secureSourceUrl(source.url)).filter(Boolean));
  return figures.filter(figure => figure?.after === after).slice(0, 2).map(figure => {
    const image = figureImageUrl(figure.url), source = secureSourceUrl(figure.sourceUrl);
    const usage = figure.usage ?? 'quote', license = secureSourceUrl(figure.licenseUrl);
    if (!image || !source || !sources.has(source) || !['quote', 'licensed', 'original'].includes(usage)) return '';
    if (usage === 'licensed' && (!license || typeof figure.licenseTitle !== 'string' || !figure.licenseTitle.trim())) return '';
    const label = usage === 'licensed' ? '写真（利用条件に基づき掲載）' : usage === 'original' ? '公開データから作図' : '資料から引用';
    return `<figure class="source-figure">
          <span class="figure-label">${label}</span>
          <a class="source-image-link" href="${escapeAttribute(image)}" target="_blank" rel="noopener noreferrer"><img src="${escapeAttribute(image)}" alt="${escapeAttribute(figure.alt)}" style="max-width:100%;height:auto" loading="lazy" decoding="async" referrerpolicy="no-referrer"></a>
          <figcaption><strong>${escapeHtml(figure.caption)}</strong><span class="source-figure-credit">${escapeHtml(figure.credit)}</span><a href="${escapeAttribute(source)}" target="_blank" rel="noopener noreferrer">出典：${escapeHtml(figure.sourceTitle)}<span aria-hidden="true"> ↗</span></a>${license ? `<a class="figure-license" href="${escapeAttribute(license)}" target="_blank" rel="noopener noreferrer">利用条件：${escapeHtml(figure.licenseTitle)}<span aria-hidden="true"> ↗</span></a>` : ''}</figcaption>
          <p class="figure-commentary"><strong>ここに注目：</strong>${escapeHtml(figure.commentary)}</p>
        </figure>`;
  }).join('\n');
}

function hasSourceFigures(article, count) {
  return (Array.isArray(article?.reading?.figures) ? article.reading.figures.slice(0, 2) : []).some(figure =>
    Number.isInteger(figure?.after) && figure.after >= 0 && figure.after < count && renderSourceFigures(article, figure.after));
}

function metadata(article, { showTime = false } = {}) {
  const kind = article.kind || 'ニュース';
  return `<div class="article-meta">
    ${article.category ? `<span class="category">${escapeHtml(article.category)}</span>` : ''}
    <span>${escapeHtml(kind)}</span>
    ${publishedDate(article.publishedAt, { showTime })}
    <span class="reading-time">約${readingMinutes(article)}分</span>
    <span class="ai-badge">AI作成</span>
  </div>`;
}

function readingMinutes(article) {
  return Math.max(1, Math.ceil(String(article.body || '').replace(/\s/g, '').length / 500));
}

function hasDiagram(article) {
  const diagram = article?.reading?.diagram;
  return Boolean(diagram && Array.isArray(diagram.items) && diagram.items.length >= 2);
}

function illustration(article, baseUrl) {
  if (!hasDiagram(article)) return '';
  const diagram = article.reading.diagram;
  const items = diagram.items.slice(0, 4);
  return `<figure class="story-visual">
        <figcaption><span class="figure-label">ひと目でわかる</span><h2>${escapeHtml(diagram.title)}</h2></figcaption>
        <img src="${escapeAttribute(absolute(articleIllustrationPath(article), baseUrl))}" width="840" height="290" alt="${escapeAttribute(items.map(item => item.label).join(diagram.type === 'compare' ? ' ／ ' : ' → '))}" decoding="async">
        <ol class="visual-legend legend-${items.length}">${items.map(item => `<li><strong>${escapeHtml(item.label)}</strong>${item.text ? `<span>${escapeHtml(item.text)}</span>` : ''}</li>`).join('')}</ol>
        ${diagram.caption ? `<p class="figure-note">${escapeHtml(diagram.caption)}</p>` : ''}
      </figure>`;
}

function takeaways(article) {
  const points = article?.reading?.takeaways;
  if (!Array.isArray(points) || !points.length) return '';
  return `<aside class="reading-overview" aria-labelledby="takeaways-title">
        <h2 id="takeaways-title"><span aria-hidden="true">◷</span> まず、ここだけ</h2>
        <ol>${points.slice(0, 3).map(point => `<li>${escapeHtml(point)}</li>`).join('')}</ol>
      </aside>`;
}

export function articleAudioHash(article) {
  return createHash('sha256').update(JSON.stringify([
    article.id, article.title, article.body,
    (article.reading?.sections || []).map(section => [section.heading, section.start]),
    article.reading?.action || '',
  ])).digest('hex');
}

function speechPlayer(article, baseUrl) {
  return `<section class="speech-player" data-speech-player data-audio-manifest="${escapeAttribute(absolute('audio/index.json', baseUrl))}" data-audio-fallback="${escapeAttribute(absolute('speech.js', baseUrl))}" data-article-id="${escapeAttribute(article.id)}" data-audio-content-hash="${articleAudioHash(article)}" hidden aria-labelledby="speech-title" aria-describedby="speech-help">
        <h2 id="speech-title" class="audio-visually-hidden">音声で聴く</h2>
        <p class="audio-current" data-audio-current data-audio-only hidden></p>
        <audio data-audio-element preload="metadata" hidden></audio>
        <div class="speech-controls">
          <button type="button" class="speech-toggle" data-speech-toggle disabled>音声を確認中</button>
          <button type="button" data-speech-stop disabled>停止</button>
          <label class="speech-rate" for="speech-rate"><span class="audio-visually-hidden">再生速度</span>
            <select id="speech-rate" data-speech-rate>
              <option value="0.8">0.8倍</option>
              <option value="1" selected>1倍</option>
              <option value="1.2">1.2倍</option>
              <option value="1.5">1.5倍</option>
              <option value="2">2倍</option>
              <option value="2.5">2.5倍</option>
              <option value="3">3倍</option>
            </select>
          </label>
        </div>
        <progress data-speech-progress value="0" max="1" aria-label="読み上げの進み具合"></progress>
        <label class="audio-position" data-audio-only hidden><span data-audio-time>0:00 / 0:00</span><input type="range" data-audio-seek min="0" max="1" value="0" step="0.1" aria-label="音声の再生位置"></label>
        <div class="audio-follow-controls" data-audio-only hidden>
          <label><input type="checkbox" data-audio-follow checked> 本文を自動で追う</label>
          <button type="button" data-audio-locate>再生位置へ</button>
        </div>
        <p class="speech-status" data-speech-status role="status" aria-live="polite" aria-atomic="true">音声ファイルを確認しています。</p>
        <details class="audio-details">
          <summary>この日の3本・再生の詳細</summary>
          <div class="speech-controls audio-chapter-controls" data-audio-only hidden>
            <button type="button" data-audio-previous>前の記事</button>
            <button type="button" data-audio-restart>記事の先頭</button>
            <button type="button" data-audio-next>次の記事</button>
          </div>
          <ol class="audio-chapters" data-audio-chapters data-audio-only hidden aria-label="この日の3本"></ol>
          <p class="speech-help" data-audio-sync-status data-audio-only hidden></p>
          <p id="speech-help" class="speech-help">開いている記事から、その日の残りの記事を続けて再生します。画面をロックしても聴けますが、端末やブラウザの設定、通信状態によって停止する場合があります。</p>
          <p class="audio-credit" data-audio-credit data-audio-only hidden></p>
        </details>
        <p class="speech-help" data-audio-fallback-reason hidden></p>
        <button type="button" class="audio-fallback" data-audio-use-fallback hidden>端末の読み上げに切り替える</button>
      </section>
      <noscript><p class="speech-noscript">音声読み上げを使うには、JavaScriptを有効にしてください。</p></noscript>`;
}

function articleBody(article, paragraphs) {
  const sections = Array.isArray(article?.reading?.sections) ? article.reading.sections : [];
  const starts = new Map(sections.filter(section => Number.isInteger(section.start) && section.start >= 0 && section.start < paragraphs.length).map(section => [section.start, section.heading]));
  return paragraphs.map((paragraph, index) => `${starts.has(index) ? `        <h2 class="story-heading" id="section-${index}" data-speech-chunk data-audio-cue="section-${index}">${escapeHtml(starts.get(index))}</h2>\n` : ''}        <p data-speech-chunk data-audio-cue="paragraph-${index}">${escapeHtml(paragraph)}</p>${renderSourceFigures(article, index)}`).join('\n');
}

function document({ title, description, baseUrl, content, pageClass = '' }) {
  const homeUrl = absolute('./', baseUrl);
  const feedUrl = absolute('feed.xml', baseUrl);
  const stylesheetUrl = absolute(`style.css?v=${AUDIO_UI_REVISION}`, baseUrl);
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <meta name="description" content="${escapeAttribute(description)}">
  <meta name="theme-color" content="#254b3e">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${escapeAttribute(stylesheetUrl)}">
  <link rel="alternate" type="application/rss+xml" title="あなたの朝の3本 RSS" href="${escapeAttribute(feedUrl)}">
</head>
<body class="${escapeAttribute(pageClass)}">
  <a class="skip-link" href="#main">本文へ移動</a>
  <header class="site-header">
    <div class="header-inner">
      <a class="brand" href="${escapeAttribute(homeUrl)}"><span class="brand-mark" aria-hidden="true">3</span><span>あなたの朝の3本</span></a>
      <a class="feed-link" href="${escapeAttribute(feedUrl)}"><svg aria-hidden="true" viewBox="0 0 20 20" width="17" height="17" fill="none"><circle cx="4" cy="16" r="1.5" fill="currentColor"/><path d="M3 9a8 8 0 0 1 8 8M3 3a14 14 0 0 1 14 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span>RSSで読む</span></a>
    </div>
  </header>
  <main id="main" class="${pageClass === 'article-page' ? 'article-main' : 'index-main'}">
${content}
  </main>
  <footer class="site-footer">
    <p>AIが作成した記事です。重要な情報は参照元もご確認ください。</p>
    <div class="footer-links"><a href="${escapeAttribute(homeUrl)}">記事一覧</a><span aria-hidden="true">·</span><a href="${escapeAttribute(feedUrl)}">RSS</a></div>
  </footer>
  ${pageClass === 'article-page' ? `<script type="module" src="${escapeAttribute(absolute(`audio-player.js?v=${AUDIO_UI_REVISION}`, baseUrl))}"></script>` : ''}
</body>
</html>
`;
}

/** Render the public article index. All article content is plain text. */
export function renderIndex({ title = 'あなたの朝の3本', baseUrl, articles = [] }) {
  const entries = Array.isArray(articles) ? articles : [];
  const latestDate = entries.length ? publishedDate(entries[0].publishedAt) : '';
  const content = `    <section class="intro" aria-labelledby="page-title">
      <p class="eyebrow">THE MORNING EDITION</p>
      <div class="intro-heading"><h1 id="page-title">JR東日本の動きを、短くつかむ。</h1>${latestDate ? `<p class="edition-date">最新号<br>${latestDate}</p>` : ''}</div>
      <p class="intro-description">何が変わったか、なぜ重要か。公開情報から、仕事への接点も整理します。</p>
    </section>
    <section class="article-list-section" aria-labelledby="articles-title">
      <div class="section-heading"><h2 id="articles-title">届いた記事</h2><span>${escapeHtml(entries.length)} ARTICLES</span></div>
      ${entries.length ? `<ol class="article-list">
${entries.map((article, index) => `        <li class="article-card">
          <span class="article-number" aria-hidden="true">${escapeHtml(String(index + 1).padStart(2, '0'))}</span>
          <article class="card-content">
            ${metadata(article)}
            <div class="card-content-main${hasDiagram(article) ? ' has-visual' : ''}">
              <div class="card-text">
                <h3><a href="${escapeAttribute(articleUrl(article, baseUrl))}">${escapeHtml(article.title)}</a></h3>
                ${article.reading?.hook || article.summary ? `<p class="article-summary">${escapeHtml(article.reading?.hook || article.summary)}</p>` : ''}
                <a class="read-link" href="${escapeAttribute(articleUrl(article, baseUrl))}" aria-label="${escapeAttribute(`${article.title}の本文を読む`)}">約${readingMinutes(article)}分で読む<span aria-hidden="true">↗</span></a>
              </div>
              ${hasDiagram(article) ? `<a class="card-visual" href="${escapeAttribute(articleUrl(article, baseUrl))}" tabindex="-1" aria-hidden="true">${renderArticleThumbnailSvg(article)}</a>` : ''}
            </div>
          </article>
        </li>`).join('\n')}
      </ol>` : '<div class="empty-state"><h3>次の朝の便りをお待ちください</h3><p>記事が届くと、ここから本文を読めます。</p></div>'}
    </section>`;
  return document({
    title,
    description: 'あなたの関心に合わせた日本語のAI作成記事を、参照元とともに毎朝3本届けます。',
    baseUrl,
    content,
    pageClass: 'index-page',
  });
}

function articleHeader(article) {
  return `<header class="article-header" data-audio-article-header>
        ${metadata(article, { showTime: true })}
        <h1 data-speech-chunk data-audio-cue="title">${escapeHtml(article.title)}</h1>
        ${article.reading?.hook || article.summary ? `<p class="article-lead">${escapeHtml(article.reading?.hook || article.summary)}</p>` : ''}
      </header>`;
}

function articleContent(article, baseUrl) {
  const sources = Array.isArray(article.sources) ? article.sources : [];
  const paragraphs = String(article.body ?? '').trim().split(/\r?\n\s*\r?\n/).filter(Boolean);
  const hasPrimaryFigure = hasSourceFigures(article, paragraphs.length);
  const sourceItems = sources.map((source) => {
    const url = sourceUrl(source.url);
    const label = source.title || source.url || '参照元';
    return `          <li>${url ? `<a href="${escapeAttribute(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}<span aria-hidden="true"> ↗</span></a><span class="source-domain">${escapeHtml(new URL(url).hostname)}</span>` : `<span>${escapeHtml(label)}</span>`}</li>`;
  }).join('\n');
  return `<div data-audio-article-content>
      ${takeaways(article)}
      ${hasPrimaryFigure ? (hasDiagram(article) ? `<p class="diagram-link"><a href="${escapeAttribute(absolute(articleIllustrationPath(article), baseUrl))}" target="_blank" rel="noopener noreferrer">要点の図解を別に見る<span aria-hidden="true"> ↗</span></a></p>` : '') : illustration(article, baseUrl)}
      <div class="article-body">
${articleBody(article, paragraphs)}
      </div>
      ${article.reading?.action ? `<aside class="try-action"><div class="action-mark" aria-hidden="true">✓</div><div><h2 data-speech-chunk data-audio-cue="action-heading">ひとつ、試してみる</h2><p data-speech-chunk data-audio-cue="action">${escapeHtml(article.reading.action)}</p></div></aside>` : ''}
      <aside class="sources" aria-labelledby="sources-title">
        <p class="eyebrow">SOURCES</p>
        <h2 id="sources-title">参照元</h2>
        ${sources.length ? `<ol>
${sourceItems}
        </ol>` : '<p>参照元はありません。</p>'}
        <p class="source-note">本文は参照元をもとにAIが作成しています。解説にはAIによる整理・考察を含みます。</p>
      </aside>
      </div>`;
}

function articleViewAttributes(article, baseUrl, title) {
  return `data-article-id="${escapeAttribute(article.id)}" data-audio-content-hash="${articleAudioHash(article)}" data-article-url="${escapeAttribute(articleUrl(article, baseUrl))}" data-document-title="${escapeAttribute(`${article.title} | ${title}`)}" data-description="${escapeAttribute(article.summary || article.title)}"`;
}

/** Render the opened article once; other daily articles stay inert until selected. */
export function renderArticle({ title = 'あなたの朝の3本', baseUrl, article, articles = [] }) {
  const dayPrefix = String(article.id).slice(0, 10);
  const others = (Array.isArray(articles) ? articles : []).filter(candidate =>
    candidate.id !== article.id && /^\d{4}-\d{2}-\d{2}-[123]$/.test(candidate.id) && candidate.id.slice(0, 10) === dayPrefix)
    .sort((left, right) => left.id.localeCompare(right.id));
  const content = `    <nav class="back-nav" aria-label="記事一覧へ"><a href="${escapeAttribute(absolute('./', baseUrl))}"><span aria-hidden="true">←</span> 記事一覧に戻る</a></nav>
    <article class="full-article" data-audio-article-root ${articleViewAttributes(article, baseUrl, title)}>
      ${articleHeader(article)}
      ${speechPlayer(article, baseUrl)}
      ${articleContent(article, baseUrl)}
    </article>
    ${others.map(candidate => `<template data-audio-article-template ${articleViewAttributes(candidate, baseUrl, title)}>${articleHeader(candidate)}${articleContent(candidate, baseUrl)}</template>`).join('\n    ')}
    <nav class="article-bottom-nav" aria-label="記事を読み終えたら"><a href="${escapeAttribute(absolute('./', baseUrl))}"><span aria-hidden="true">←</span> ほかの記事を読む</a><a href="${escapeAttribute(absolute('feed.xml', baseUrl))}">RSSで受け取る <span aria-hidden="true">↗</span></a></nav>`;
  return document({
    title: `${article.title} | ${title}`,
    description: article.summary || article.title,
    baseUrl,
    content,
    pageClass: 'article-page',
  });
}
