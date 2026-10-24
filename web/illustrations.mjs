const escapeXml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&apos;');

const ICONS = {
  chat: '<path d="M10 12h38a7 7 0 0 1 7 7v20a7 7 0 0 1-7 7H28L16 55v-9h-6a7 7 0 0 1-7-7V19a7 7 0 0 1 7-7Z"/><path d="M15 25h28M15 34h19"/>',
  check: '<rect x="8" y="8" width="48" height="48" rx="13"/><path d="m19 32 9 9 19-20" stroke-width="5"/>',
  arrow: '<circle cx="32" cy="32" r="25"/><path d="M18 32h28M35 21l11 11-11 11"/>',
  shoe: '<path d="m9 18 12 9 10 1 8 11 17 8v8H8c-5 0-6-4-5-9l4-12 2-16Z"/><path d="M5 47h49M27 31l-5 6M33 35l-5 6M14 26l-5 13"/>',
  shirt: '<path d="m21 8-17 9 7 15 9-4v29h25V28l8 4 8-15-18-9-11 7-11-7Z"/><path d="m21 8 11 19L43 8M32 27v26"/><circle cx="37" cy="34" r="1" fill="currentColor"/><circle cx="37" cy="43" r="1" fill="currentColor"/>',
  book: '<path d="M32 15C24 9 12 9 5 13v39c9-4 18-4 27 2 8-6 18-6 27-2V13c-9-4-19-4-27 2Zm0 0v39"/><path d="M12 23c5-1 9 0 13 2M12 32c5-1 9 0 13 2M39 25c4-2 8-3 13-2M39 34c4-2 8-3 13-2"/>',
  headphones: '<path d="M8 36v-7a24 24 0 0 1 48 0v7"/><rect x="5" y="30" width="12" height="25" rx="5"/><rect x="47" y="30" width="12" height="25" rx="5"/><path d="M47 53c-3 6-8 7-14 7"/>',
  run: '<circle cx="39" cy="9" r="6"/><path d="m31 20 9 10 13 3M34 22l-12 8-12-2M30 28l6 14 14 11M34 40l-15 1-9 14" stroke-width="4.5"/>',
  clock: '<circle cx="32" cy="32" r="25"/><path d="M32 16v17l12 8M32 7v4M57 32h-4M32 57v-4M7 32h4"/>',
  home: '<path d="m4 29 28-23 28 23M11 25v31h42V25"/><path d="M26 56V37h13v19M17 31h6M43 31h5"/>',
  bolt: '<path d="M35 4 11 35h18l-3 25 27-35H35l3-21Z" fill="#dcae51"/>',
  train: '<rect x="12" y="5" width="40" height="48" rx="10"/><path d="M12 31h40M32 12v19M19 12h26M21 53l-8 8M43 53l8 8M18 59h29"/><circle cx="22" cy="41" r="3" fill="currentColor"/><circle cx="42" cy="41" r="3" fill="currentColor"/>',
  battery: '<rect x="4" y="16" width="49" height="32" rx="5"/><path d="M54 25h6v14h-6M13 25v14M23 25v14M33 25v14"/>',
  document: '<path d="M12 5h26l14 14v40H12V5Z"/><path d="M38 5v15h14M21 31h22M21 40h22M21 49h13"/>',
};

function wrapped(value, width = 8, maxLines = 2) {
  const characters = Array.from(String(value ?? '').trim());
  const lines = [];
  while (characters.length && lines.length < maxLines) lines.push(characters.splice(0, width).join(''));
  if (characters.length && lines.length) lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1) + '…';
  return lines;
}

export function articleIllustrationPath(article) {
  return `illustrations/${encodeURIComponent(String(article.id))}.svg`;
}

function iconMarkup(item, comparison = false) {
  let markup = ICONS[item?.icon] || ICONS.document;
  if (comparison && item?.icon === 'shoe') {
    const label = String(item.label || '');
    const dark = /黒|black/i.test(label);
    const fill = dark ? '#3f4e46' : /グレー|gray|grey/i.test(label) ? '#aebbb3' : '#fcfbf6';
    markup = markup.replace('<path ', `<path fill="${fill}" `);
    if (dark) markup = markup.replace('<path d="M5', '<path stroke="#fcfbf6" d="M5');
  }
  return markup;
}

/** A large, recognizable motif for compact index cards. */
export function renderArticleThumbnailSvg(article) {
  const items = article?.reading?.diagram?.items;
  if (!Array.isArray(items) || items.length < 2) return '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360" aria-hidden="true">
    <rect width="640" height="360" rx="26" fill="#e8eddf"/>
    <circle cx="600" cy="20" r="184" fill="#d5e2d0"/>
    <path d="M0 300c130-77 183-6 300-26s206-64 340-26v112H0Z" fill="#d9e4d0"/>
    <circle cx="250" cy="168" r="136" fill="#fcfbf6" opacity=".88"/>
    <g transform="translate(150 68) scale(3.12)" color="#254b3e" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${iconMarkup(items[0], article.reading.diagram.type === 'compare')}</g>
    <circle cx="474" cy="260" r="68" fill="#eadab8" stroke="#fcfbf6" stroke-width="8"/>
    <g transform="translate(434 220) scale(1.25)" color="#536c49" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">${iconMarkup(items[1], article.reading.diagram.type === 'compare')}</g>
    ${items[2] ? `<circle cx="516" cy="110" r="48" fill="#dce6ec" stroke="#fcfbf6" stroke-width="6"/><g transform="translate(486 80) scale(.94)" color="#536c49" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${iconMarkup(items[2], article.reading.diagram.type === 'compare')}</g>` : ''}
  </svg>`;
}

/** Fixed vector artwork; article data can only become escaped text, never SVG markup. */
export function renderIllustrationSvg(article) {
  const diagram = article?.reading?.diagram;
  if (!diagram || !Array.isArray(diagram.items) || diagram.items.length < 2) return '';
  const items = diagram.items.slice(0, 4);
  const count = items.length;
  const gap = 780 / count;
  const centers = items.map((_, index) => 30 + gap * (index + .5));
  const radius = count === 4 ? 54 : 63;
  const palette = ['#dce8dd', '#e9dfc8', '#dce6ec', '#e9dee5'];
  const connectors = diagram.type === 'compare' ? '' : centers.slice(0, -1).map((center, i) => {
    const x1 = center + radius + 12;
    const x2 = centers[i + 1] - radius - 14;
    return `<path d="M${x1} 111h${Math.max(5, x2 - x1)}m-9-8 9 8-9 8" fill="none" stroke="#76917b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
  const nodes = items.map((item, index) => {
    const center = centers[index];
    const scale = count === 4 ? 1.53 : 1.72;
    const label = wrapped(item.label, count === 4 ? 7 : 8, 2);
    return `<g>
      <circle cx="${center}" cy="111" r="${radius + 8}" fill="${palette[index]}" opacity=".45"/>
      <circle cx="${center}" cy="111" r="${radius}" fill="${palette[index]}"/>
      <g transform="translate(${center - 32 * scale} ${111 - 32 * scale}) scale(${scale})" color="#254b3e" fill="none" stroke="currentColor" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round">${iconMarkup(item, diagram.type === 'compare')}</g>
      <circle cx="${center - radius + 5}" cy="54" r="15" fill="#fcfbf6" stroke="#ced8c7"/>
      <text x="${center - radius + 5}" y="60" text-anchor="middle" fill="#4c6a51" font-size="17" font-weight="700">${index + 1}</text>
      <text x="${center}" y="221" text-anchor="middle" fill="#253c33" font-size="${count === 4 ? 25 : 27}" font-weight="700">${label.map((line, lineIndex) => `<tspan x="${center}" dy="${lineIndex ? 35 : 0}">${escapeXml(line)}</tspan>`).join('')}</text>
    </g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="840" height="290" viewBox="0 0 840 290" role="img" aria-labelledby="diagram-title diagram-desc">
  <title id="diagram-title">${escapeXml(diagram.title)}</title>
  <desc id="diagram-desc">${escapeXml(items.map(item => [item.label, item.text].filter(Boolean).join('：')).join('。'))}</desc>
  <rect width="840" height="290" rx="24" fill="#f0f2e8"/>
  <path d="M0 254c94-40 110 31 207 8s139-23 215 2 114-28 218-7 145 14 200-9v42H0Z" fill="#e8eddc"/>
  <circle cx="816" cy="22" r="76" fill="#e5ebd9"/><circle cx="18" cy="16" r="40" fill="#e9e2d0" opacity=".65"/>
  <g font-family="-apple-system,BlinkMacSystemFont,'Hiragino Kaku Gothic ProN','Yu Gothic',Meiryo,sans-serif">${connectors}${nodes}</g>
</svg>\n`;
}
