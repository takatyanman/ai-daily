import {readFile,writeFile,readdir,mkdir,rm,copyFile} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {renderIndex,renderArticle} from '../web/render.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const xml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
export function publicUrl(s){const u=new URL(s);if(u.protocol!=='https:'||u.username||u.password)throw Error('HTTPS URL required');return u.href;}
export function validateDay(day){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day.date)||!Array.isArray(day.articles)||day.articles.length!==3)throw Error('Each day must contain exactly three articles');
 const ids=new Set();
 for(const [i,a] of day.articles.entries()){
  if(a.id!==`${day.date}-${i+1}`||ids.has(a.id))throw Error('Stable daily article IDs required');ids.add(a.id);
  for(const k of ['title','category','summary','body','publishedAt','kind'])if(typeof a[k]!=='string'||!a[k].trim())throw Error(`Missing ${k}`);
  if(a.title.length>200||a.summary.length>600||a.body.length>20000)throw Error('Article is too long');
  if(!['解説','ニュース'].includes(a.kind))throw Error('Article kind required');
  const date=new Date(a.publishedAt);if(!Number.isFinite(date.valueOf()))throw Error('Invalid publication date');
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).map(p=>[p.type,p.value]));
  if(`${parts.year}-${parts.month}-${parts.day}`!==day.date)throw Error('Publication date must match Japan date');
  if(!Array.isArray(a.sources)||a.sources.length<1||a.sources.length>8)throw Error('One to eight source links required');
  for(const s of a.sources){if(!s.title||!s.url)throw Error('Source title and URL required');publicUrl(s.url);}
 }
 return day.articles;
}
export function renderFeed({title,baseUrl,articles}){
 const base=publicUrl(baseUrl.endsWith('/')?baseUrl:baseUrl+'/');
 const items=articles.slice(0,30).map(a=>{
  const url=new URL(`articles/${a.id}.html`,base).href;
  const full=a.body.split(/\n\s*\n/).map(p=>`<p>${xml(p).replaceAll('\n','<br>')}</p>`).join('');
  const encoded=full.replaceAll(']]>',']]]]><![CDATA[>');
  return `<item><title>${xml(a.title)}</title><link>${xml(url)}</link><guid isPermaLink="true">${xml(url)}</guid><pubDate>${new Date(a.publishedAt).toUTCString()}</pubDate><category>AI作成記事</category><category>${xml(a.category)}</category><description>${xml(a.summary)}</description><content:encoded><![CDATA[${encoded}]]></content:encoded></item>`;
 }).join('\n');
 return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${xml(title)}</title><link>${xml(base)}</link><description>関心メモに沿った毎朝3本のAI作成記事。出典を付け、事実と解説を区別します。</description><language>ja</language><atom:link href="${xml(new URL('feed.xml',base).href)}" rel="self" type="application/rss+xml"/>${articles[0]?`<lastBuildDate>${new Date(articles[0].publishedAt).toUTCString()}</lastBuildDate>`:''}\n${items}\n</channel></rss>\n`;
}
export async function buildSite({projectRoot=root,output=join(projectRoot,'dist'),baseUrl}={}){
 const config=JSON.parse(await readFile(join(projectRoot,'site.json'),'utf8'));
 const base=publicUrl(baseUrl||process.env.SITE_BASE_URL||config.baseUrl).replace(/\/?$/,'/');
 if(process.env.CI==='true'&&new URL(base).hostname==='example.invalid')throw Error('Configure a real Pages URL before deployment');
 const files=(await readdir(join(projectRoot,'content'))).filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
 const articles=[];for(const file of files){const day=JSON.parse(await readFile(join(projectRoot,'content',file),'utf8'));if(file!==`${day.date}.json`)throw Error('Day file/date mismatch');articles.push(...validateDay(day));}
 if(!articles.length)throw Error('At least one complete daily edition is required');
 articles.sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt)||a.id.localeCompare(b.id));
 await rm(output,{recursive:true,force:true});await mkdir(join(output,'articles'),{recursive:true});
 const context={title:config.title,baseUrl:base,articles};
 await writeFile(join(output,'index.html'),renderIndex(context));await writeFile(join(output,'feed.xml'),renderFeed(context));
 for(const article of articles)await writeFile(join(output,'articles',`${article.id}.html`),renderArticle({...context,article}));
 await copyFile(join(projectRoot,'web/style.css'),join(output,'style.css'));
 await writeFile(join(output,'robots.txt'),'User-agent: *\nDisallow: /\n');await writeFile(join(output,'.nojekyll'),'');
 return {articles:articles.length,days:files.length,baseUrl:base,output};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)console.log(JSON.stringify(await buildSite()));
