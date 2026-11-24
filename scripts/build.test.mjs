import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {validateDay,validateRelatedArticles,renderFeed,buildSite} from './build.mjs';
import {renderArticle,renderIndex,articleAudioHash} from '../web/render.mjs';
import {renderIllustrationSvg,renderArticleThumbnailSvg} from '../web/illustrations.mjs';
import {createSpeechReader,splitForSpeech} from '../web/speech.mjs';
import './audio-player.test.mjs';
const day=JSON.parse(await readFile(new URL('../content/2026-10-25.json',import.meta.url),'utf8'));
const context={title:'朝の3本',baseUrl:'https://example.test/ai-daily/',articles:day.articles};
const withoutTemplates=html=>html.replace(/<template\b[^>]*>[\s\S]*?<\/template>/g,'');
function syntheticDay(date){
 return {date,articles:[1,2,3].map(number=>({
  id:`${date}-${number}`,title:`検証用の記事${number}`,category:'事業創造',summary:'表示を確かめるための検証記事です。',
  body:'検証用の第一段落です。\n\n検証用の第二段落です。\n\n以前の検証記事では、試作後の反応を判断に使うと整理しました。今回は集めた反応を次の試作条件に変える点を確かめます。',
  publishedAt:`${date}T02:00:00+09:00`,kind:'解説',sources:[{title:'検証用の一次資料',url:'https://example.test/primary-source'}],
  reading:{hook:'検証用の導入です。',takeaways:['第一の要点です。','第二の要点です。','第三の要点です。'],sections:[{heading:'仕組みを確かめる',start:0},{heading:'判断をつなぐ',start:2}],diagram:{type:'flow',title:'検証用の図',items:[{icon:'document',label:'反応',text:'反応を集める'},{icon:'arrow',label:'判断',text:'次の条件を決める'}],caption:'検証用の説明です。'},action:'検証用の判断条件を一つ書き出します。'},
 }))};
}
function connectedEditions(){
 const older=syntheticDay('2026-10-20'),newer=syntheticDay('2026-10-21');
 const target=older.articles[1];
 newer.articles[0].reading.relatedArticle={id:target.id,title:target.title};
 return {older,newer,article:newer.articles[0],articles:[...newer.articles,...older.articles],target};
}
test('the visual edition has three stable, sourced articles',()=>{assert.equal(validateDay(day).length,3);});
test('partial editions, invalid IDs and reference protocols are rejected',()=>{
 for(const modify of [d=>d.articles.pop(),d=>d.articles[0].id='wrong',d=>d.articles[0].sources[0].url='javascript:alert(1)',d=>d.articles[0].publishedAt='invalid']){
  const copy=structuredClone(day);modify(copy);assert.throws(()=>validateDay(copy));
 }
});
test('RSS identifiers are stable and links point into the reader site',()=>{
 const rss=renderFeed(context);assert.equal(rss,renderFeed(structuredClone(context)));
 assert.equal((rss.match(/<item>/g)||[]).length,3);
 for(const a of day.articles)assert.ok(rss.includes(`https://example.test/ai-daily/articles/${a.id}.html`));
});
test('untrusted article text is escaped in reader HTML and XML',()=>{
 const a={...day.articles[0],title:'A & <script>x</script>',body:'Text <script>bad()</script> & end ]]> next'};
 const html=renderArticle({...context,article:a});assert.ok(!html.includes('<script>bad()'));assert.ok(html.includes('&lt;script&gt;'));
 const rss=renderFeed({...context,articles:[a]});assert.ok(!rss.includes('<title>A & <script>'));assert.ok(rss.includes('&amp;'));
});
test('reading section indexes cannot hide, repeat or skip the start of the body',()=>{
 for(const modify of [
  r=>r.sections[0].start=1,
  r=>r.sections[1].start=r.sections[0].start,
  r=>r.sections[1].start=999,
  r=>r.diagram.items[0].icon='https://untrusted.test/image.svg',
  r=>r.takeaways.pop(),
 ]){
  const copy=structuredClone(day);modify(copy.articles[0].reading);assert.throws(()=>validateDay(copy));
 }
});
test('visual articles keep every body paragraph once and provide actual illustration links',()=>{
 for(const a of day.articles){
  const html=renderArticle({...context,article:a});
  for(const p of a.body.split(/\n\s*\n/))assert.equal(html.split(p).length-1,1);
  assert.ok(html.includes(`illustrations/${a.id}.svg`));
  for(const s of a.reading.sections)assert.ok(html.includes(s.heading));
  assert.ok(renderArticleThumbnailSvg(a).includes('width="640" height="360"'));
  assert.ok(!renderArticleThumbnailSvg(a).includes('<text'));
 }
 const rss=renderFeed(context);
 assert.equal((rss.match(/<media:thumbnail /g)||[]).length,3);
 assert.ok(rss.includes('-thumb.png'));
});
test('article metadata cannot inject SVG or HTML',()=>{
 const a=structuredClone(day.articles[0]);
 a.reading.hook='<img src=x onerror=alert(1)>';
 a.reading.diagram.title='</title><script>bad()</script>';
 a.reading.diagram.items[0].label='<foreignObject>';
 const svg=renderIllustrationSvg(a),html=renderArticle({...context,article:a}),rss=renderFeed({...context,articles:[a]});
 assert.ok(!svg.includes('<script>')&&!svg.includes('<foreignObject>'));
 assert.ok(svg.includes('&lt;/title&gt;'));
 assert.ok(!html.includes('<img src=x')&&!rss.includes('<img src=x'));
});
test('older plain articles remain readable without broken illustration references',()=>{
 const a=structuredClone(day.articles[0]);delete a.reading;
 const html=renderArticle({...context,article:a}),rss=renderFeed({...context,articles:[a]});
 assert.ok(!withoutTemplates(html).includes('illustrations/'));
 assert.ok(!rss.includes('<media:thumbnail '));
 assert.ok(html.includes(a.body.split('\n\n')[0]));
});

test('one related article must match a real article from an older edition',()=>{
 const {older,newer,articles}=connectedEditions(),before=structuredClone(articles);
 assert.equal(validateDay(older).length,3);assert.equal(validateDay(newer).length,3);
 assert.doesNotThrow(()=>validateRelatedArticles(articles));
 assert.deepEqual(articles,before,'validation must not normalize existing article data');
 for(const modify of [
  fixture=>fixture.articles=fixture.articles.filter(a=>a.id!==fixture.target.id),
  fixture=>fixture.article.reading.relatedArticle.title='存在する記事とは違うタイトル',
  fixture=>fixture.article.reading.relatedArticle={id:fixture.article.id,title:fixture.article.title},
  fixture=>fixture.article.reading.relatedArticle={id:fixture.newer.articles[1].id,title:fixture.newer.articles[1].title},
  fixture=>{const future=syntheticDay('2026-10-22').articles[0];fixture.articles.push(future);fixture.article.reading.relatedArticle={id:future.id,title:future.title};},
  fixture=>fixture.target.publishedAt='2026-10-21T03:00:00+09:00',
 ]){
  const fixture=connectedEditions();modify(fixture);
  assert.throws(()=>validateRelatedArticles(fixture.articles),/Related article/);
 }
});

test('related article metadata accepts only one bounded local ID and title',()=>{
 const invalid=[null,[],{},[{id:'2026-10-20-2',title:'複数指定'}],
  {id:'2026-10-20-2'},{title:'IDがない'},
  {id:'2026-10-20-2',title:' '},{id:'2026-10-20-2',title:'あ'.repeat(201)},
  {id:'2026-10-20-2',title:'検証',url:'https://outside.example/article'},
  ...['2026-10-20-4','../2026-10-20-2','https://outside.example/article','javascript:alert(1)','2026-10-20-2\" onclick=\"bad()'].map(id=>({id,title:'検証'})),
 ];
 for(const reference of invalid){
  const copy=syntheticDay('2026-10-21');copy.articles[0].reading.relatedArticle=reference;
  assert.throws(()=>validateDay(copy),/related article/);
  assert.throws(()=>validateRelatedArticles(copy.articles),/related article/);
  assert.ok(!renderArticle({...context,articles:copy.articles,article:copy.articles[0]}).includes('関連する過去記事：'));
  assert.ok(!renderFeed({...context,articles:copy.articles}).includes('関連する過去記事：'));
 }
});

test('HTML and RSS place one related link after the narrated body and before the action',()=>{
 const {article,articles,target}=connectedEditions();
 const html=withoutTemplates(renderArticle({...context,articles,article}));
 const rss=renderFeed({...context,articles:[article]});
 const url=`https://example.test/ai-daily/articles/${target.id}.html`;
 const body=article.body.split('\n\n'),last=body.at(-1);
 for(const output of [html,rss]){
  assert.equal(output.split(`href="${url}"`).length-1,1);
  assert.ok(output.indexOf(last)<output.indexOf('関連する過去記事：'));
  assert.ok(output.indexOf('関連する過去記事：')<output.indexOf(article.reading.action));
  for(const paragraph of body)assert.equal(output.split(paragraph).length-1,1);
  const link=output.match(/<p class="diagram-link">関連する過去記事：[\s\S]*?<\/p>/)?.[0];
  assert.ok(link?.includes(`>${target.title}<span`));
  assert.ok(link.includes('target="_blank" rel="noopener noreferrer"'));
  assert.ok(!link.includes('data-speech-chunk')&&!link.includes('data-audio-cue'));
 }
 assert.equal((html.match(/data-audio-cue="paragraph-2"/g)||[]).length,1);
 assert.ok(html.includes(`data-audio-cue="paragraph-2">${last}</p>`));
 const withoutLink=structuredClone(article);delete withoutLink.reading.relatedArticle;
 assert.equal(articleAudioHash(article),articleAudioHash(withoutLink));
 assert.deepEqual(article.sources,withoutLink.sources);
 assert.equal(renderIndex({...context,articles:[article]}),renderIndex({...context,articles:[withoutLink]}));
});

test('related links in inert daily templates appear when their article is selected',()=>{
 const {newer,articles,target}=connectedEditions();
 const html=renderArticle({...context,articles,article:newer.articles[1]});
 assert.ok(!withoutTemplates(html).includes('関連する過去記事：'));
 const template=html.match(/<template\b[^>]*data-article-id="2026-10-21-1"[^>]*>([\s\S]*?)<\/template>/)?.[1];
 assert.ok(template?.includes(`articles/${target.id}.html`));
 assert.equal((template.match(/関連する過去記事：/g)||[]).length,1);
});

test('related article titles cannot inject HTML, attributes or CDATA',()=>{
 const {older,newer,article,articles,target}=connectedEditions();
 const attack='\"><script>bad()</script> ]]> & quote';
 target.title=attack;article.reading.relatedArticle.title=attack;
 validateDay(older);validateDay(newer);validateRelatedArticles(articles);
 for(const output of [renderArticle({...context,articles,article}),renderFeed({...context,articles:[article]})]){
  assert.ok(!output.includes('<script>bad()'));
  assert.ok(output.includes('&quot;&gt;&lt;script&gt;bad()&lt;/script&gt; ]]&gt; &amp; quote'));
  assert.ok(!output.includes(']]> & quote'));
 }
});

test('absent related metadata preserves pre-feature article HTML, RSS and audio hashes',()=>{
 const edition=syntheticDay('2026-10-21');
 const fixtureContext={title:'検証用の朝の3本',baseUrl:context.baseUrl,articles:edition.articles};
 const hash=value=>createHash('sha256').update(value).digest('hex');
 // Captured from the renderer before related-article support, using only this synthetic edition.
 assert.equal(hash(renderArticle({...fixtureContext,article:edition.articles[0]})),'e2fd35c2fb5ce13bf74c0caa1943080e0cd21f3dea4a60c19530d96cf4ba4c45');
 assert.equal(hash(renderFeed(fixtureContext)),'8d56fa75d1bf80ae8c88dea09a670e8be3e91b1dbf1ea8ea355e8a312b4e640e');
 assert.equal(articleAudioHash(edition.articles[0]),'33cb96e0039e5056b26733881063fd804a266eb00308cba57968147b3f4dcee0');
});

test('a build validates related targets before replacing output and publishes valid links',async()=>{
 const temporary=await mkdtemp(join(tmpdir(),'ai-daily-related-'));
 try{
  const {older,newer,article,target}=connectedEditions();
  await mkdir(join(temporary,'content'));await mkdir(join(temporary,'web'));
  await mkdir(join(temporary,'dist'));const sentinel=join(temporary,'dist','prior-output.txt');
  await writeFile(sentinel,'previous verified output');
  await writeFile(join(temporary,'site.json'),JSON.stringify({title:'関連記事の検証',baseUrl:context.baseUrl}));
  for(const name of ['style.css','speech.mjs','audio-player.mjs','index-search.mjs','index-search.css'])await writeFile(join(temporary,'web',name),'');
  const newerPath=join(temporary,'content',`${newer.date}.json`);
  await writeFile(newerPath,JSON.stringify(newer));
  await assert.rejects(buildSite({projectRoot:temporary}),/Related article target not found/);
  assert.equal(await readFile(sentinel,'utf8'),'previous verified output');
  await writeFile(join(temporary,'content',`${older.date}.json`),JSON.stringify(older));
  article.reading.relatedArticle.title='別のタイトル';await writeFile(newerPath,JSON.stringify(newer));
  await assert.rejects(buildSite({projectRoot:temporary}),/Related article title must match/);
  assert.equal(await readFile(sentinel,'utf8'),'previous verified output');
  article.reading.relatedArticle.title=target.title;await writeFile(newerPath,JSON.stringify(newer));
  const result=await buildSite({projectRoot:temporary});
  assert.equal(result.articles,6);assert.equal(result.days,2);
  const html=await readFile(join(temporary,'dist','articles',`${article.id}.html`),'utf8');
  const rss=await readFile(join(temporary,'dist','feed.xml'),'utf8');
  assert.ok(html.includes(`href="${context.baseUrl}articles/${target.id}.html"`));
  assert.ok(rss.includes(`関連する過去記事：<a href="${context.baseUrl}articles/${target.id}.html"`));
 }finally{await rm(temporary,{recursive:true,force:true});}
});

const figureSource={title:'公式発表のテスト資料',url:'https://www.jreast.co.jp/press/2026/example.html'};
function quotedDay(){
 const copy=structuredClone(day),a=copy.articles[0];
 a.sources.push(figureSource);
 a.reading.figures=[{after:0,url:'https://prcdn.freetls.fastly.net/release_image/17557/example.png?width=640&quality=80',alt:'発表資料に掲載された設備の写真',caption:'設備の写真を資料から引用',sourceTitle:figureSource.title,sourceUrl:figureSource.url,credit:'出典：JR東日本',commentary:'写真のどの部分が本文の変更点に当たるかを読み取ります。'}];
 return copy;
}

test('index search starts hidden and uses escaped public metadata without adding article body text',()=>{
 const article=syntheticDay('2026-10-21').articles[0];
 article.summary='要約だけの語 & "水力"';
 article.reading.hook='導入だけの語 <案内>';
 const index=renderIndex({...context,articles:[article]});
 const body=renderArticle({...context,articles:[article],article});
 assert.ok(index.includes('data-index-search role="search" hidden'));
 assert.ok(index.includes(`data-index-search-id="${article.id}"`));
 assert.ok(index.includes(`data-index-search-text="${article.title}\n${article.category}\n要約だけの語 &amp; &quot;水力&quot;\n導入だけの語 &lt;案内&gt;"`));
 assert.ok(index.includes(`src="${context.baseUrl}index-search.js?v=history"`));
 assert.ok(!index.includes(article.body.split('\n\n')[0]));
 assert.ok(!body.includes('index-search.js')&&!body.includes('data-index-search-text'));
});

test('index cards preview the article figure and link to its full explanation',()=>{
 const copy=quotedDay(),article=copy.articles[0],before=structuredClone(copy);
 const html=renderIndex({...context,articles:copy.articles});
 const articleHtml=renderArticle({...context,article});
 const articleUrl=`${context.baseUrl}articles/${article.id}.html`;
 const card=html.match(/<li class="article-card"[^>]*>[\s\S]*?<\/li>/)[0];
 assert.ok(card.includes('data-article-preview="figure"'));
 assert.ok(card.includes('src="https://prcdn.freetls.fastly.net/release_image/17557/example.png?width=640&amp;quality=80"'));
 assert.ok(card.includes(`<a class="card-visual" href="${articleUrl}#source-figure-1" aria-label="${article.title}の図と出典を見る"`));
 assert.ok(articleHtml.includes('<figure class="source-figure" id="source-figure-1" tabindex="-1"'));
 assert.ok(card.includes(`<h3><a href="${articleUrl}"`));
 assert.ok(card.includes(`<a class="read-link" href="${articleUrl}"`));
 assert.ok(card.includes('object-fit:contain')&&card.includes('referrerpolicy="no-referrer"'));
 assert.ok(!card.includes('<svg'));
 const cards=html.match(/<li class="article-card"[^>]*>[\s\S]*?<\/li>/g);
 for(const fallback of cards.slice(1)){
  assert.ok(fallback.includes('<svg'),'articles without a figure retain their existing preview');
  assert.ok(!fallback.includes('#source-figure-'));
 }
 assert.deepEqual(copy,before,'a preview must not rewrite published article data');
});

test('index previews cannot use uncited, unattributed, out-of-context or unsafe figures',()=>{
 for(const change of [
  f=>f.url='javascript:alert(1)',
  f=>f.url='https://jreast.co.jp.evil.test/image.jpg',
  f=>f.sourceUrl='https://unlisted.test/source',
  f=>f.credit=' ',
  f=>f.commentary='',
  f=>f.after=999,
  f=>{f.usage='licensed';delete f.licenseTitle;delete f.licenseUrl;},
 ]){
  const article=quotedDay().articles[0];change(article.reading.figures[0]);
  const html=renderIndex({...context,articles:[article]});
  assert.ok(!html.includes('data-article-preview="figure"'));
  assert.ok(html.includes('<svg'));
 }
 const article=quotedDay().articles[0],valid=structuredClone(article.reading.figures[0]);
 article.reading.figures=[{...valid,after:999},valid];
 assert.ok(renderIndex({...context,articles:[article]}).includes(`${article.id}.html#source-figure-2"`));
 const body=renderArticle({...context,article});
 assert.ok(body.includes('<figure class="source-figure" id="source-figure-2"'));
 assert.ok(!body.includes('id="source-figure-1"'));
 article.reading.figures=[{...valid,after:999},{...valid,credit:''},valid];
 assert.ok(!renderIndex({...context,articles:[article]}).includes('data-article-preview="figure"'));
});

test('figure preview attribution is escaped rather than interpreted as markup',()=>{
 const article=quotedDay().articles[0];
 article.reading.figures[0].caption='資料 " onload="bad() <script> &';
 const html=renderIndex({...context,articles:[article]});
 assert.ok(html.includes('資料 &quot; onload=&quot;bad() &lt;script&gt; &amp;'));
 assert.ok(!html.includes(' onload="bad()')&&!html.includes('<script> &'));
});

test('a cited figure stays with its body context in HTML and RSS without replacing the PNG thumbnail',()=>{
 const copy=quotedDay(),a=copy.articles[0];assert.equal(validateDay(copy).length,3);
 const html=renderArticle({...context,article:a}),rss=renderFeed({...context,articles:copy.articles});
 const p=a.body.split(/\n\s*\n/);
 assert.ok(html.indexOf(p[0])<html.indexOf('class="source-figure"'));
 assert.ok(html.indexOf('class="source-figure"')<html.indexOf(p[1]));
 assert.equal((html.match(/class="source-figure"/g)||[]).length,1);
 assert.ok(html.includes('資料から引用')&&html.includes(a.reading.figures[0].commentary));
 assert.ok(html.includes('referrerpolicy="no-referrer"'));
 assert.ok(rss.indexOf('-thumb.png')<rss.indexOf('release_image/17557/example.png'));
 assert.ok(rss.includes(figureSource.url)&&rss.includes(a.reading.figures[0].credit));
 assert.ok(!rss.includes('id="source-figure-'));
 assert.equal((rss.match(/<media:thumbnail /g)||[]).length,3);
 for(const text of p)assert.equal(html.split(text).length-1,1);
});

test('quoted figures require bounded context, attribution and approved image URLs',()=>{
 const changes=[
  a=>a.reading.figures=null,
  a=>a.reading.figures.push(...structuredClone(a.reading.figures),...structuredClone(a.reading.figures)),
  ...[-1,.5,999].map(after=>a=>a.reading.figures[0].after=after),
  ...['alt','caption','sourceTitle','sourceUrl','credit','commentary'].map(k=>a=>a.reading.figures[0][k]=' '),
  a=>a.reading.figures[0].sourceUrl='https://unlisted.example/source',
  ...['http://www.jreast.co.jp/image.png','javascript:alert(1)','data:image/png;base64,a',
   'https://jreast.co.jp.evil.example/photo.png','https://jreast.co.jp@evil.example/photo.png',
   'https://www.jreast.co.jp:8443/photo.png','https://prcdn.freetls.fastly.net.evil.example/photo.png',
   'https://takatyanman.github.io/other/photo.png','https://takatyanman.github.io/ai-daily/figures/../private.png',
   'https://takatyanman.github.io/ai-daily/figures/photo.svg','https://takatyanman.github.io/ai-daily/figures/photo.png?other=1',
  ].map(url=>a=>a.reading.figures[0].url=url),
 ];
 for(const modify of changes){const copy=quotedDay();modify(copy.articles[0]);assert.throws(()=>validateDay(copy));}
 const empty=structuredClone(day);empty.articles[0].reading.figures=[];
 assert.equal(renderArticle({...context,article:empty.articles[0]}),renderArticle({...context,article:day.articles[0]}));
 assert.equal(renderFeed({...context,articles:empty.articles}),renderFeed(context));
});

test('quoted figure metadata cannot inject HTML, attributes or CDATA',()=>{
 const a=quotedDay().articles[0],attack='\"><script>bad()</script> ]]> & quote';
 for(const key of ['alt','caption','sourceTitle','credit','commentary'])a.reading.figures[0][key]=attack;
 const html=renderArticle({...context,article:a}),rss=renderFeed({...context,articles:[a]});
 assert.ok(!html.includes('<script>')&&!rss.includes('<script>'));
 assert.ok(html.includes('&quot;&gt;&lt;script&gt;'));
 assert.ok(rss.includes('&lt;script&gt;')&&!rss.includes(']]> & quote'));
 a.reading.figures[0].url='javascript:alert(1)';
 assert.ok(!renderArticle({...context,article:a}).includes('class="source-figure"'));
});

test('licensed photos and original charts keep their distinct attribution and replace only the inline generic diagram',()=>{
 const copy=quotedDay(),a=copy.articles[0],f=a.reading.figures[0];
 f.usage='licensed';f.url='https://thumb.wikimedia.org/wikipedia/commons/thumb/example.jpg/1280px-example.jpg';
 f.licenseTitle='CC BY-SA 4.0';f.licenseUrl='https://creativecommons.org/licenses/by-sa/4.0/';
 assert.equal(validateDay(copy).length,3);
 const html=renderArticle({...context,article:a}),rss=renderFeed({...context,articles:[a]});
 assert.ok(html.includes('写真（利用条件に基づき掲載）')&&rss.includes('CC BY-SA 4.0'));
 assert.ok(html.includes('href="https://creativecommons.org/licenses/by-sa/4.0/"'));
 assert.ok(!withoutTemplates(html).includes('class="story-visual"'));
 assert.ok(html.includes(`href="https://example.test/ai-daily/illustrations/${a.id}.svg"`));
 assert.ok(html.indexOf('class="reading-overview"')<html.indexOf('class="source-figure"'));
 for(const key of ['licenseTitle','licenseUrl']){
  const invalid=structuredClone(copy);delete invalid.articles[0].reading.figures[0][key];assert.throws(()=>validateDay(invalid));
 }
 f.usage='original';delete f.licenseTitle;delete f.licenseUrl;
 assert.equal(validateDay(copy).length,3);
 assert.ok(renderArticle({...context,article:a}).includes('公開データから作図'));
 f.usage='unknown';assert.throws(()=>validateDay(copy));
 const legacy=renderArticle({...context,article:day.articles[0]});
 assert.ok(legacy.indexOf('class="reading-overview"')<legacy.indexOf('class="story-visual"'));
});

test('a build copies only referenced raster assets and rejects disguised or linked files',async()=>{
 const temporary=await mkdtemp(join(tmpdir(),'ai-daily-figures-'));
 try{
  const copy=quotedDay(),name='press-quote.png',image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
  copy.articles[0].reading.figures[0].url=`https://takatyanman.github.io/ai-daily/figures/${name}`;
  await mkdir(join(temporary,'content'));await mkdir(join(temporary,'web','figures'),{recursive:true});
  await writeFile(join(temporary,'content',`${copy.date}.json`),JSON.stringify(copy));
  await writeFile(join(temporary,'site.json'),JSON.stringify({title:'図の検証',baseUrl:context.baseUrl}));
  await writeFile(join(temporary,'web','style.css'),'body{color:#000}');
  await writeFile(join(temporary,'web','speech.mjs'),'export const fixture = true;');
  await writeFile(join(temporary,'web','audio-player.mjs'),'export const audioFixture = true;');
  await writeFile(join(temporary,'web','index-search.mjs'),'export const indexFixture = true;');
  await writeFile(join(temporary,'web','index-search.css'),'.index-search{margin:1em}');
  const source=join(temporary,'web','figures',name);
  await writeFile(source,image);await writeFile(join(temporary,'web','figures','unreferenced.png'),image);
  await buildSite({projectRoot:temporary});
  assert.deepEqual(await readFile(join(temporary,'dist','figures',name)),image);
  assert.equal(await readFile(join(temporary,'dist','speech.js'),'utf8'),'export const fixture = true;');
  assert.equal(await readFile(join(temporary,'dist','audio-player.js'),'utf8'),'export const audioFixture = true;');
  assert.equal(await readFile(join(temporary,'dist','index-search.js'),'utf8'),'export const indexFixture = true;');
  assert.equal(await readFile(join(temporary,'dist','index-search.css'),'utf8'),'.index-search{margin:1em}');
  const searchBodies=JSON.parse(await readFile(join(temporary,'dist','article-search.json'),'utf8'));
  assert.deepEqual(searchBodies,Object.fromEntries(copy.articles.map(({id,body})=>[id,body])));
  await assert.rejects(readFile(join(temporary,'dist','figures','unreferenced.png')));
  await writeFile(source,'<html>This is not a PNG.</html>');
  await assert.rejects(buildSite({projectRoot:temporary}),/Invalid or oversized quoted image asset/);
  await rm(source);await symlink(join(temporary,'web','figures','unreferenced.png'),source);
  await assert.rejects(buildSite({projectRoot:temporary}),/Invalid quoted image file/);
 }finally{await rm(temporary,{recursive:true,force:true});}
});

test('speech chunks preserve Japanese punctuation and Unicode and bound long utterances',()=>{
 const value='第一文。絵文字🚃を含む第二文！'+ 'あ'.repeat(400);
 const chunks=splitForSpeech(value);
 assert.equal(chunks.join(''),value);
 assert.ok(chunks.every(s=>Array.from(s).length<=160));
 assert.deepEqual(splitForSpeech(' \n\t '),[]);
});

function speechFixture(segments=['第一文。','第二文。']){
 const utterances=[];
 const voice={name:'日本語',lang:'ja-JP',localService:true};
 const synth={getVoices:()=>[{name:'English',lang:'en-US',default:true},voice],cancel(){},speak(u){utterances.push(u);u.onstart?.();}};
 class Utterance{constructor(text){this.text=text;}}
 const reader=createSpeechReader({synth,Utterance,segments});
 return {reader,synth,utterances,voice};
}

test('reading advances in order, chooses Japanese and restarts after completion',()=>{
 const {reader,utterances,voice}=speechFixture();
 assert.equal(utterances.length,0,'page loading must never autoplay');
 reader.play();assert.equal(utterances[0].text,'第一文。');assert.equal(utterances[0].lang,'ja-JP');assert.equal(utterances[0].voice,voice);
 reader.play();assert.equal(utterances.length,1,'repeat play cannot overlap');
 utterances[0].onend();assert.equal(utterances[1].text,'第二文。');
 utterances[1].onend();assert.equal(reader.state().phase,'finished');assert.equal(reader.state().index,2);
 reader.play();assert.equal(utterances[2].text,'第一文。');
});

test('pause resumes the current sentence and ignores late cancelled events',()=>{
 const {reader,utterances}=speechFixture();reader.play();utterances[0].onend();
 const interrupted=utterances[1];reader.pause();
 assert.equal(reader.state().phase,'paused');assert.equal(reader.state().index,1);
 interrupted.onend();interrupted.onerror({error:'canceled'});
 assert.equal(reader.state().phase,'paused');assert.equal(utterances.length,2);
 reader.play();assert.equal(utterances[2].text,'第二文。');
 interrupted.onend();assert.equal(reader.state().index,1);
 utterances[2].onend();assert.equal(reader.state().phase,'finished');
});

test('speed changes replay only the current sentence and stop discards stale callbacks',()=>{
 const {reader,utterances}=speechFixture();reader.play();const old=utterances[0];
 reader.setRate('1.5');assert.equal(utterances[1].rate,1.5);assert.equal(utterances[1].text,'第一文。');
 old.onend();assert.equal(reader.state().index,0);
 reader.pause();reader.setRate('0.8');assert.equal(utterances.length,2);
 reader.play();assert.equal(utterances[2].rate,0.8);
 reader.setRate('99');assert.equal(reader.state().rate,0.8);
 const stopped=utterances[2];reader.stop();stopped.onend();stopped.onerror({error:'network'});
 assert.equal(reader.state().phase,'idle');assert.equal(reader.state().index,0);assert.equal(utterances.length,3);
});

test('voice loading, speech errors and external interruption remain retryable',()=>{
 const {reader,synth,utterances,voice}=speechFixture();
 synth.getVoices=()=>[{lang:'en-US'}];reader.play();assert.equal(reader.state().error,'language-unavailable');assert.equal(utterances.length,0);
 synth.getVoices=()=>[voice];reader.play();assert.equal(reader.state().phase,'playing');
 utterances[0].onerror({error:'network'});assert.equal(reader.state().phase,'error');
 reader.play();utterances[1].onerror({error:'interrupted'});assert.equal(reader.state().phase,'paused');
 reader.play();assert.equal(utterances[2].text,'第一文。');
});
