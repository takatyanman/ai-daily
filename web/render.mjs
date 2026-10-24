const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const escapeAttribute = escapeHtml;

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

function metadata(article, { showTime = false } = {}) {
  const kind = article.kind || 'ニュース';
  return `<div class="article-meta">
    ${article.category ? `<span class="category">${escapeHtml(article.category)}</span>` : ''}
    <span>${escapeHtml(kind)}</span>
    ${publishedDate(article.publishedAt, { showTime })}
    <span class="ai-badge">AI作成</span>
  </div>`;
}

function document({ title, description, baseUrl, content, pageClass = '' }) {
  const homeUrl = absolute('./', baseUrl);
  const feedUrl = absolute('feed.xml', baseUrl);
  const stylesheetUrl = absolute('style.css', baseUrl);
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
      <div class="intro-heading"><h1 id="page-title">朝のひと息に、<br>今日の視点を。</h1>${latestDate ? `<p class="edition-date">最新号<br>${latestDate}</p>` : ''}</div>
      <p class="intro-description">あなたの関心に合わせた3本を。<br class="mobile-break">話題の要点と背景を、参照元とともに届けます。</p>
    </section>
    <section class="article-list-section" aria-labelledby="articles-title">
      <div class="section-heading"><h2 id="articles-title">届いた記事</h2><span>${escapeHtml(entries.length)} ARTICLES</span></div>
      ${entries.length ? `<ol class="article-list">
${entries.map((article, index) => `        <li class="article-card">
          <span class="article-number" aria-hidden="true">${escapeHtml(String(index + 1).padStart(2, '0'))}</span>
          <article>
            ${metadata(article)}
            <h3><a href="${escapeAttribute(articleUrl(article, baseUrl))}">${escapeHtml(article.title)}</a></h3>
            ${article.summary ? `<p class="article-summary">${escapeHtml(article.summary)}</p>` : ''}
            <a class="read-link" href="${escapeAttribute(articleUrl(article, baseUrl))}" aria-label="${escapeAttribute(`${article.title}の本文を読む`)}">本文を読む<span aria-hidden="true">↗</span></a>
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

/** Render an article with escaped paragraphs and explicit source links. */
export function renderArticle({ title = 'あなたの朝の3本', baseUrl, article }) {
  const sources = Array.isArray(article.sources) ? article.sources : [];
  const paragraphs = String(article.body ?? '').trim().split(/\r?\n\s*\r?\n/).filter(Boolean);
  const sourceItems = sources.map((source) => {
    const url = sourceUrl(source.url);
    const label = source.title || source.url || '参照元';
    return `          <li>${url ? `<a href="${escapeAttribute(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}<span aria-hidden="true"> ↗</span></a><span class="source-domain">${escapeHtml(new URL(url).hostname)}</span>` : `<span>${escapeHtml(label)}</span>`}</li>`;
  }).join('\n');
  const content = `    <nav class="back-nav" aria-label="記事一覧へ"><a href="${escapeAttribute(absolute('./', baseUrl))}"><span aria-hidden="true">←</span> 記事一覧に戻る</a></nav>
    <article class="full-article">
      <header class="article-header">
        ${metadata(article, { showTime: true })}
        <h1>${escapeHtml(article.title)}</h1>
        ${article.summary ? `<p class="article-lead">${escapeHtml(article.summary)}</p>` : ''}
      </header>
      <div class="article-body">
${paragraphs.map((paragraph) => `        <p>${escapeHtml(paragraph)}</p>`).join('\n')}
      </div>
      <aside class="sources" aria-labelledby="sources-title">
        <p class="eyebrow">SOURCES</p>
        <h2 id="sources-title">参照元</h2>
        ${sources.length ? `<ol>
${sourceItems}
        </ol>` : '<p>参照元はありません。</p>'}
        <p class="source-note">本文は参照元をもとにAIが作成しています。解説にはAIによる整理・考察を含みます。</p>
      </aside>
    </article>
    <nav class="article-bottom-nav" aria-label="記事を読み終えたら"><a href="${escapeAttribute(absolute('./', baseUrl))}"><span aria-hidden="true">←</span> ほかの記事を読む</a><a href="${escapeAttribute(absolute('feed.xml', baseUrl))}">RSSで受け取る <span aria-hidden="true">↗</span></a></nav>`;
  return document({
    title: `${article.title} | ${title}`,
    description: article.summary || article.title,
    baseUrl,
    content,
    pageClass: 'article-page',
  });
}
