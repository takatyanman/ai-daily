import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateDay,renderFeed} from './build.mjs';
import {renderArticle} from '../web/render.mjs';
const day=JSON.parse(await readFile(new URL('../content/2026-10-24.json',import.meta.url),'utf8'));
const context={title:'朝の3本',baseUrl:'https://example.test/ai-daily/',articles:day.articles};
test('the initial edition has three stable, sourced articles',()=>{assert.equal(validateDay(day).length,3);});
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
