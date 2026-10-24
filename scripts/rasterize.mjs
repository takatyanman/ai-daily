import {readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Resvg} from '@resvg/resvg-js';
import {validateDay} from './build.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=join(root,'dist');
const articles=[];
for(const name of (await readdir(join(root,'content'))).filter(n=>/^\d{4}-\d{2}-\d{2}\.json$/.test(n))){
 const day=JSON.parse(await readFile(join(root,'content',name),'utf8'));
 articles.push(...validateDay(day));
}
articles.sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt)||a.id.localeCompare(b.id));
const selected=articles.slice(0,30).filter(a=>a.reading);
if(!selected.length){console.log(JSON.stringify({pngThumbnails:0}));process.exit(0);}
const started=Date.now();
for(const article of selected){
 const svg=await readFile(join(output,'illustrations',`${article.id}-thumb.svg`),'utf8');
 const bytes=new Resvg(svg,{font:{loadSystemFonts:false}}).render().asPng();
 if(bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.readUInt32BE(16)!==640||bytes.readUInt32BE(20)!==360)throw Error(`Invalid PNG thumbnail: ${article.id}`);
 await writeFile(join(output,'illustrations',`${article.id}-thumb.png`),bytes);
}
console.log(JSON.stringify({pngThumbnails:selected.length,renderer:'resvg',elapsedMs:Date.now()-started}));
