import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AUDIO_RATES,validateAudioManifest,createAudioReader,audioChapterAt,formatAudioTime,validateAudioArticleViews,matchingAudioCues,audioCueAt} from '../web/audio-player.mjs';

const date='2026-11-03',hash='a'.repeat(64);
const chapters=[0,1,2].map(i=>({id:`${date}-${i+1}`,title:`記事${i+1}`,start:i*10,end:(i+1)*10,articleHash:'b'.repeat(64)}));
const context={manifestUrl:'https://takatyanman.github.io/ai-daily/audio/index.json',pageUrl:`https://takatyanman.github.io/ai-daily/articles/${date}-2.html`,articleId:chapters[1].id,articleTitle:chapters[1].title,articleHash:chapters[1].articleHash};
function manifest(){return{version:1,voice:{name:'HTS voice',credit:'NIT/TIT',licenseTitle:'CC BY 3.0',licenseUrl:'https://creativecommons.org/licenses/by/3.0/',sourceUrl:'https://example.test/copyright'},days:{[date]:{url:`${date}-${hash.slice(0,12)}.mp3`,duration:30,sha256:hash,articles:structuredClone(chapters)}}};}

test('all three article views must match before switching text during playback',()=>{
 const views=chapters.map(article=>({id:article.id,title:article.title,articleHash:article.articleHash,url:new URL(`${article.id}.html`,context.pageUrl).href}));
 assert.equal(validateAudioArticleViews(chapters,views,context.pageUrl).size,3);
 for(const modify of [v=>v.pop(),v=>v[2].articleHash='c'.repeat(64),v=>v[2].title='古い本文',v=>v[2].url='https://other.test/article.html',v=>v[2].url='https://takatyanman.github.io/ai-daily/other.html',v=>v[2]=v[0]]){
  const bad=structuredClone(views);modify(bad);assert.throws(()=>validateAudioArticleViews(chapters,bad,context.pageUrl));
 }
});

test('only measured cues with matching visible text can highlight the current segment',()=>{
 const cues=[{key:'title',text:'記事1',start:0,end:2},{key:'section-0',text:'何が変わるか',start:2,end:4},{key:'paragraph-0',text:'本文\r\n続き',start:4,end:10}];
 const article={...chapters[0],cues};const texts={'title':'記事1','section-0':'何が変わるか','paragraph-0':'本文\n続き'};
 const matched=matchingAudioCues(article,texts);assert.equal(matched.length,3);
 assert.equal(audioCueAt(matched,4).key,'paragraph-0');assert.equal(audioCueAt(matched,2-0.0000005).key,'section-0');
 assert.equal(audioCueAt(matched,10),null);assert.equal(audioCueAt(matched,NaN),null);
 const partly=matchingAudioCues(article,{...texts,'section-0':'別の見出し'});assert.equal(partly.length,2);assert.equal(audioCueAt(partly,3),null);
 assert.deepEqual(matchingAudioCues(chapters[0],texts),[]);
 for(const modify of [v=>v[1].start=1.5,v=>v[1].key='title',v=>v[1].key='paragraph-0"]',v=>v[2].end=11,v=>v[2].start=NaN]){
  const bad=structuredClone(cues);modify(bad);assert.deepEqual(matchingAudioCues({...article,cues:bad},texts),[]);
 }
});

test('audio manifest binds the requested article to its text and confines media to this site',()=>{
 const result=validateAudioManifest(manifest(),context);assert.equal(result.currentIndex,1);assert.ok(result.day.url.startsWith('https://takatyanman.github.io/ai-daily/audio/'));
 assert.throws(()=>validateAudioManifest(manifest(),{...context,articleTitle:'別の記事'}),/content-mismatch/);
 assert.throws(()=>validateAudioManifest(manifest(),{...context,articleHash:'c'.repeat(64)}),/content-mismatch/);
 for(const path of ['https://other.test/audio.mp3','../audio.mp3',`../${date}-${hash.slice(0,12)}.mp3`]){const value=manifest();value.days[date].url=path;assert.throws(()=>validateAudioManifest(value,context),/audio-url/);}
 const stale=manifest();stale.days[date].sha256='c'.repeat(64);assert.throws(()=>validateAudioManifest(stale,context),/audio-url/);
 const overlap=manifest();overlap.days[date].articles[1].start=9;assert.throws(()=>validateAudioManifest(overlap,context),/audio-chapters/);
});

class FakeAudio extends EventTarget{
 constructor(){super();this.duration=30;this.readyState=1;this.currentTime=0;this.defaultPlaybackRate=1;this.playbackRate=1;this.paused=true;this.playCalls=0;this.src='same-daily-file.mp3';}
 play(){this.playCalls++;if(this.rejectPlay)return Promise.reject(this.rejectPlay);this.paused=false;this.dispatchEvent(new Event('playing'));return Promise.resolve();}
 pause(){if(!this.paused){this.paused=true;this.dispatchEvent(new Event('pause'));}}
 load(){this.playbackRate=this.defaultPlaybackRate;}
 tick(value){this.currentTime=value;this.dispatchEvent(new Event('timeupdate'));}
}
function fixture(startIndex=0){const audio=new FakeAudio();const reader=createAudioReader({audio,articles:chapters,duration:30,startIndex});return{reader,audio};}

test('daily MP3 begins at the opened article and crosses chapters without another play request',async()=>{
 const {reader,audio}=fixture(1);assert.equal(audio.playCalls,0);await reader.play();assert.equal(audio.currentTime,10);assert.equal(audio.playCalls,1);
 audio.tick(20.25);assert.equal(reader.state().index,2);assert.equal(reader.state().phase,'playing');assert.equal(audio.playCalls,1);assert.equal(audio.src,'same-daily-file.mp3');
 reader.stop();assert.equal(reader.state().phase,'idle');assert.equal(audio.currentTime,10);reader.dispose();
});

test('chapter detection tolerates browser media-time rounding at a seek boundary',()=>{
 const fractional=[{start:0},{start:196.48722916666668},{start:359.12583333333333}];
 assert.equal(audioChapterAt(fractional,196.487229),1);
 assert.equal(audioChapterAt(fractional,196.48),0);
 assert.equal(audioChapterAt(fractional,359.125833),2);
});

test('audio speeds include three times and chapter controls preserve playback',async()=>{
 const {reader,audio}=fixture();await reader.play();reader.setRate(3);assert.equal(audio.playbackRate,3);reader.setRate(99);assert.equal(reader.state().rate,3);
 assert.equal(AUDIO_RATES.at(-1),3);reader.next();assert.equal(audio.currentTime,10);assert.equal(audio.playCalls,1);
 reader.previous();assert.equal(audio.currentTime,0);reader.pause();assert.equal(reader.state().phase,'paused');await reader.play();assert.equal(audio.playCalls,2);reader.dispose();
});

test('the selected speed survives native load and an external reset during playback',async()=>{
 const {reader,audio}=fixture(1);reader.setRate(3);
 assert.equal(audio.defaultPlaybackRate,3);audio.load();assert.equal(audio.playbackRate,3);
 await reader.play();audio.tick(14);const source=audio.src,playCalls=audio.playCalls;
 for(const event of ['ratechange','loadedmetadata','playing','seeked']){
  audio.defaultPlaybackRate=1;audio.playbackRate=1;audio.dispatchEvent(new Event(event));
  assert.equal(audio.defaultPlaybackRate,3,event);assert.equal(audio.playbackRate,3,event);
  assert.equal(reader.state().rate,3);assert.equal(reader.state().phase,'playing');assert.equal(reader.state().index,1);
  assert.equal(audio.currentTime,14);assert.equal(audio.playCalls,playCalls);assert.equal(audio.src,source);
 }
 audio.playbackRate=1;await reader.play();assert.equal(audio.playbackRate,3);assert.equal(audio.playCalls,playCalls,'already playing must only repair the rate');
 audio.tick(15);audio.playbackRate=1;audio.dispatchEvent(new Event('ratechange'));assert.equal(audio.playbackRate,3,'a later independent reset is repaired again');
 reader.dispose();audio.playbackRate=1;audio.dispatchEvent(new Event('ratechange'));assert.equal(audio.playbackRate,1,'disposed listeners cannot modify the media');
});

test('a visibility or page-restoration checkpoint repairs speed without playing or seeking',async()=>{
 const {reader,audio}=fixture(1);reader.setRate(2.5);
 for(const phase of ['idle','paused','error']){
  if(phase==='paused'){await reader.play();audio.tick(14);reader.pause();}
  if(phase==='error')audio.dispatchEvent(new Event('error'));
  const before=reader.state(),playCalls=audio.playCalls,source=audio.src;
  audio.defaultPlaybackRate=1;audio.playbackRate=1;reader.syncRate();
  assert.equal(audio.defaultPlaybackRate,2.5);assert.equal(audio.playbackRate,2.5);
  assert.deepEqual(reader.state(),before);assert.equal(audio.playCalls,playCalls);assert.equal(audio.src,source);
 }
 reader.dispose();
});

test('an exhausted correction burst reports the actual speed and clears after recovery',async()=>{
 const audio=new FakeAudio(),changes=[];
 const reader=createAudioReader({audio,articles:chapters,duration:30,startIndex:1,onChange:state=>changes.push(state)});
 reader.setRate(3);await reader.play();audio.tick(14);
 const playCalls=audio.playCalls,source=audio.src;
 for(let i=0;i<3;i++){audio.playbackRate=1;audio.dispatchEvent(new Event('ratechange'));}
 assert.equal(reader.state().rate,3);assert.equal(reader.state().actualRate,1);assert.equal(reader.state().rateUnavailable,true);
 assert.equal(changes.at(-1).actualRate,1,'the UI receives the mismatch even before another timeupdate');
 assert.equal(reader.state().phase,'playing');assert.equal(reader.state().position,14);assert.equal(audio.playCalls,playCalls);assert.equal(audio.src,source);
 reader.syncRate();assert.equal(reader.state().actualRate,3);assert.equal(reader.state().rateUnavailable,false);assert.equal(changes.at(-1).rateUnavailable,false);
 audio.playbackRate=NaN;assert.equal(reader.state().actualRate,null);assert.equal(reader.state().rateUnavailable,true);
 reader.syncRate();assert.equal(reader.state().actualRate,3);assert.equal(reader.state().rateUnavailable,false);reader.dispose();
});

test('a rejected default speed does not hide a working current speed or exhaust future repairs',()=>{
 const audio=new FakeAudio();Object.defineProperty(audio,'defaultPlaybackRate',{get:()=>1,set(){throw new DOMException('unsupported','NotSupportedError');}});
 const reader=createAudioReader({audio,articles:chapters,duration:30});reader.setRate(3);
 assert.equal(reader.state().actualRate,3);assert.equal(reader.state().rateUnavailable,false);
 for(let i=0;i<4;i++){
  audio.tick(i+1);audio.playbackRate=1;audio.dispatchEvent(new Event('ratechange'));
  assert.equal(reader.state().actualRate,3);assert.equal(reader.state().rateUnavailable,false);
 }
 reader.dispose();
});

test('rate repair tolerates rejected or synchronously clamped native setters without recursion',()=>{
 const audio=new FakeAudio();let current=1,defaultWrites=0,currentWrites=0;
 Object.defineProperty(audio,'defaultPlaybackRate',{get:()=>1,set(){defaultWrites++;throw new DOMException('unsupported','NotSupportedError');}});
 Object.defineProperty(audio,'playbackRate',{get:()=>current,set(value){currentWrites++;current=Math.min(2,value);audio.dispatchEvent(new Event('ratechange'));}});
 const reader=createAudioReader({audio,articles:chapters,duration:30});
 assert.doesNotThrow(()=>reader.setRate(3));assert.equal(current,2);assert.equal(defaultWrites,1);assert.equal(currentWrites,1);assert.equal(reader.state().rateUnavailable,true);
 for(let i=0;i<20;i++)audio.dispatchEvent(new Event('ratechange'));
 assert.equal(defaultWrites,1);assert.equal(currentWrites,1);assert.equal(reader.state().phase,'idle');
 reader.setRate(1.5);assert.equal(current,1.5,'an unsupported default cannot prevent a supported current speed');reader.dispose();
});

test('asynchronous rate clamping cannot create an endless ratechange correction chain',async()=>{
 const audio=new FakeAudio();let current=1,writes=0;
 Object.defineProperty(audio,'playbackRate',{get:()=>current,set(value){
  writes++;current=value;
  if(value>2)queueMicrotask(()=>{current=2;audio.dispatchEvent(new Event('ratechange'));});
 }});
 const reader=createAudioReader({audio,articles:chapters,duration:30});reader.setRate(3);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(writes,3,'one requested write plus two bounded corrections');assert.equal(current,2);assert.equal(reader.state().actualRate,2);assert.equal(reader.state().rateUnavailable,true);
 audio.dispatchEvent(new Event('ratechange'));assert.equal(writes,3);assert.equal(reader.state().phase,'idle');assert.equal(audio.playCalls,0);
 reader.setRate(1.5);assert.equal(current,1.5);assert.equal(reader.state().rateUnavailable,false);reader.dispose();
});

test('playback denial stays paused for a user gesture and a failed file can be retried',async()=>{
 const {reader,audio}=fixture();audio.rejectPlay=new DOMException('blocked','NotAllowedError');await reader.play();assert.equal(reader.state().phase,'paused');assert.equal(reader.state().error,'play-blocked');
 audio.rejectPlay=null;await reader.play();audio.tick(4);audio.dispatchEvent(new Event('error'));assert.equal(reader.state().phase,'error');
 await reader.play();assert.equal(reader.state().phase,'playing');assert.equal(audio.currentTime,4);reader.dispose();
});

test('stop cancels both delayed metadata play requests without later autoplay',async()=>{
 const {reader,audio}=fixture(1);audio.readyState=0;audio.duration=NaN;
 const first=reader.play();reader.pause();const second=reader.play();reader.stop();
 audio.readyState=1;audio.duration=30;audio.dispatchEvent(new Event('loadedmetadata'));await Promise.all([first,second]);
 assert.equal(audio.playCalls,0);assert.equal(reader.state().phase,'idle');assert.equal(reader.state().position,10);reader.dispose();
});

test('incorrect metadata duration is rejected and a finished recording restarts at the opened article',async()=>{
 const bad=fixture();bad.audio.duration=28;await bad.reader.play();assert.equal(bad.reader.state().error,'duration-mismatch');bad.reader.dispose();
 const {reader,audio}=fixture(1);await reader.play();audio.tick(30);audio.paused=true;audio.dispatchEvent(new Event('ended'));assert.equal(reader.state().phase,'finished');await reader.play();assert.equal(audio.currentTime,10);reader.dispose();
 assert.equal(audioChapterAt(chapters,29),2);assert.equal(formatAudioTime(65),'1:05');
});
