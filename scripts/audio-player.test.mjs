import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AUDIO_RATES,validateAudioManifest,createAudioReader,audioChapterAt,formatAudioTime} from '../web/audio-player.mjs';

const date='2026-11-03',hash='a'.repeat(64);
const chapters=[0,1,2].map(i=>({id:`${date}-${i+1}`,title:`記事${i+1}`,start:i*10,end:(i+1)*10,articleHash:'b'.repeat(64)}));
const context={manifestUrl:'https://takatyanman.github.io/ai-daily/audio/index.json',pageUrl:`https://takatyanman.github.io/ai-daily/articles/${date}-2.html`,articleId:chapters[1].id,articleTitle:chapters[1].title,articleHash:chapters[1].articleHash};
function manifest(){return{version:1,voice:{name:'HTS voice',credit:'NIT/TIT',licenseTitle:'CC BY 3.0',licenseUrl:'https://creativecommons.org/licenses/by/3.0/',sourceUrl:'https://example.test/copyright'},days:{[date]:{url:`${date}-${hash.slice(0,12)}.mp3`,duration:30,sha256:hash,articles:structuredClone(chapters)}}};}

test('audio manifest binds the requested article to its text and confines media to this site',()=>{
 const result=validateAudioManifest(manifest(),context);assert.equal(result.currentIndex,1);assert.ok(result.day.url.startsWith('https://takatyanman.github.io/ai-daily/audio/'));
 assert.throws(()=>validateAudioManifest(manifest(),{...context,articleTitle:'別の記事'}),/content-mismatch/);
 assert.throws(()=>validateAudioManifest(manifest(),{...context,articleHash:'c'.repeat(64)}),/content-mismatch/);
 for(const path of ['https://other.test/audio.mp3','../audio.mp3',`../${date}-${hash.slice(0,12)}.mp3`]){const value=manifest();value.days[date].url=path;assert.throws(()=>validateAudioManifest(value,context),/audio-url/);}
 const stale=manifest();stale.days[date].sha256='c'.repeat(64);assert.throws(()=>validateAudioManifest(stale,context),/audio-url/);
 const overlap=manifest();overlap.days[date].articles[1].start=9;assert.throws(()=>validateAudioManifest(overlap,context),/audio-chapters/);
});

class FakeAudio extends EventTarget{
 constructor(){super();this.duration=30;this.readyState=1;this.currentTime=0;this.playbackRate=1;this.paused=true;this.playCalls=0;this.src='same-daily-file.mp3';}
 play(){this.playCalls++;if(this.rejectPlay)return Promise.reject(this.rejectPlay);this.paused=false;this.dispatchEvent(new Event('playing'));return Promise.resolve();}
 pause(){if(!this.paused){this.paused=true;this.dispatchEvent(new Event('pause'));}}
 load(){}
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
