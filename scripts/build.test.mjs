import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateDay,renderFeed} from './build.mjs';
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
