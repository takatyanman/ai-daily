import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {validateDay,renderFeed,buildSite} from './build.mjs';
import {renderArticle} from '../web/render.mjs';
import {renderIllustrationSvg,renderArticleThumbnailSvg} from '../web/illustrations.mjs';
const day=JSON.parse(await readFile(new URL('../content/2026-10-25.json',import.meta.url),'utf8'));
const context={title:'朝の3本',baseUrl:'https://example.test/ai-daily/',articles:day.articles};
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
 assert.ok(!html.includes('illustrations/'));
 assert.ok(!rss.includes('<media:thumbnail '));
 assert.ok(html.includes(a.body.split('\n\n')[0]));
});

const figureSource={title:'公式発表のテスト資料',url:'https://www.jreast.co.jp/press/2026/example.html'};
function quotedDay(){
 const copy=structuredClone(day),a=copy.articles[0];
 a.sources.push(figureSource);
 a.reading.figures=[{after:0,url:'https://prcdn.freetls.fastly.net/release_image/17557/example.png?width=640&quality=80',alt:'発表資料に掲載された設備の写真',caption:'設備の写真を資料から引用',sourceTitle:figureSource.title,sourceUrl:figureSource.url,credit:'出典：JR東日本',commentary:'写真のどの部分が本文の変更点に当たるかを読み取ります。'}];
 return copy;
}

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
 assert.ok(!html.includes('class="story-visual"'));
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
  const source=join(temporary,'web','figures',name);
  await writeFile(source,image);await writeFile(join(temporary,'web','figures','unreferenced.png'),image);
  await buildSite({projectRoot:temporary});
  assert.deepEqual(await readFile(join(temporary,'dist','figures',name)),image);
  await assert.rejects(readFile(join(temporary,'dist','figures','unreferenced.png')));
  await writeFile(source,'<html>This is not a PNG.</html>');
  await assert.rejects(buildSite({projectRoot:temporary}),/Invalid or oversized quoted image asset/);
  await rm(source);await symlink(join(temporary,'web','figures','unreferenced.png'),source);
  await assert.rejects(buildSite({projectRoot:temporary}),/Invalid quoted image file/);
 }finally{await rm(temporary,{recursive:true,force:true});}
});
