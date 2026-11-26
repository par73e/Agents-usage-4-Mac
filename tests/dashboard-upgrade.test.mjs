import test from 'node:test';
import assert from 'node:assert/strict';
import {exact, short, percent, roundCeiling, wallText, clockParts} from '../web/src/content/dashboard/format.js';
import {splitModelName, modelKey, modelTitle, modelId, groupModels, rankModels} from '../web/src/content/dashboard/models.js';
import {previousRange, changePercent, quietRange, zoneMinute} from '../web/src/content/dashboard/range-compare.js';
import {timeTicks, zonedTime, roundUp, axisName} from '../web/src/content/dashboard/time-ticks.js';

const SH='Asia/Shanghai';
const at=text=>Date.parse(text);
// Buckets of ``minutes``, the first starting at ``from``, each named as the log names it.
function bins(from,count,minutes){
  return Array.from({length:count},(_,i)=>{const start=from+i*minutes*60000,end=start+minutes*60000,p=clockParts(start,SH);
    return{id:String(i),start_ms:start,end_ms:end,start:new Date(start).toISOString(),end:new Date(end).toISOString(),label:`${p.month}/${p.day} ${p.hour}:${p.minute}`,partial:false};});
}
const model=(name,tokens,responses=1)=>({name,tokens,responses,efforts:{high:tokens},response_ids:[`${name}-1`],
  buckets:[{tokens,responses,efforts:{high:tokens},cached:0,uncached:tokens,cache_unknown:0,output:0}]});

test('a count is written in full under one 万, and in 万 and 亿 above it',()=>{
  assert.equal(short(2277),'2,277');assert.equal(short(9999),'9,999');
  assert.equal(short(18493),'1.85万');assert.equal(short(33246004),'3324.6万');
  assert.equal(short(353044393),'3.53亿');assert.equal(short(0),'0');assert.equal(short(null),'0');
  assert.equal(exact(91481768),'91,481,768');assert.equal(exact(12.6),'13');
  assert.equal(percent(1,3),'33.3');assert.equal(percent(5,0),null);assert.equal(percent(0,10),null);
  assert.equal(wallText('2026-11-19T16:59'),'11/19 16:59');assert.equal(wallText('2026-11-19'),'11/19');assert.equal(wallText(null),'');
});

test('the top of a value axis is a round number that is not below the tallest bar',()=>{
  assert.equal(roundCeiling(91481768),100000000);assert.equal(roundCeiling(22500000),25000000);
  assert.equal(roundCeiling(74693000),100000000,'75 is not one of the round steps');assert.equal(roundCeiling(25100000),50000000);assert.equal(roundCeiling(7500),10000);assert.equal(roundCeiling(20000000),20000000);
  assert.equal(roundCeiling(0),1);assert.equal(roundCeiling(-5),1);
});

test('a model is the part of its name after the last slash',()=>{
  assert.deepEqual(splitModelName('imported-2/gpt-6.2-sol'),{model:'gpt-6.2-sol',tag:'imported-2'});
  assert.deepEqual(splitModelName('workbuddy/glm-5.3'),{model:'glm-5.3',tag:'workbuddy'});
  assert.deepEqual(splitModelName('Gemini 4 Neon'),{model:'Gemini 4 Neon',tag:''});
  assert.equal(modelTitle('workbuddy/glm-5.3'),'glm-5.3');assert.equal(modelTitle('workbuddy/glm-5.3',false),'workbuddy/glm-5.3');
  assert.equal(modelTitle('unknown'),'未知模型');assert.equal(modelTitle(undefined),'未知模型');
});

test('the same model is one key however it is written, and two models stay two',()=>{
  assert.equal(modelKey('gpt-6.2-sol'),modelKey('imported-2/GPT_6.2 sol'));
  assert.equal(modelKey('workbuddy/kimi-k3-1'),'kimik31');assert.equal(modelKey('workbuddy/kimi-k3.1-pro'),'kimik3.1pro');
  assert.notEqual(modelKey('workbuddy/kimi-k3-1'),modelKey('workbuddy/kimi-k3.1-pro'));
  assert.equal(modelKey('unknown'),'unknown');assert.equal(modelKey(''),'unknown');
  assert.equal(modelId('gpt6.2sol'),'model-gpt6-2e-2sol');assert.notEqual(modelId('glm5.3'),modelId('glm53'));
});

test('ways of writing one model are merged into one chart, and nothing is lost',()=>{
  const source=[model('imported-2/gpt-6.2-sol',50,2),model('gpt-6.2-sol',100,3),model('workbuddy/glm-5.3',20,1)];
  const before=JSON.stringify(source);
  const merged=groupModels(source,true);
  assert.deepEqual(merged.map(group=>[group.title,group.tokens,group.responses]),[['gpt-6.2-sol',150,5],['glm-5.3',20,1]]);
  assert.deepEqual(merged[0].names,['imported-2/gpt-6.2-sol','gpt-6.2-sol']);
  assert.deepEqual(merged[0].response_ids,['imported-2/gpt-6.2-sol-1','gpt-6.2-sol-1']);
  assert.equal(merged[0].buckets[0].tokens,150);assert.equal(merged[0].buckets[0].responses,5);assert.equal(merged[0].efforts.high,150);
  assert.equal(JSON.stringify(source),before);
  // Unmerged, every way of writing stays its own chart, under its whole name.
  const separate=groupModels(source,false);
  assert.deepEqual(separate.map(group=>group.title),['gpt-6.2-sol','imported-2/gpt-6.2-sol','workbuddy/glm-5.3']);
  assert.equal(separate[0].names.length,1);
});

test('the ranking puts one model on one row, split by agent, largest first',()=>{
  const rows=rankModels([
    {agent:'codex',models:[model('gpt-6.2-sol',100,3),model('imported-2/gpt-6.2-sol',50,2),model('workbuddy/glm-5.3',20,1),model('unknown',0,0)]},
    {agent:'claude',models:[model('workbuddy/glm-5.3',5,1),model('zhipu/glm-5.4',300,9)]},
  ],true);
  assert.deepEqual(rows.map(row=>[row.title,row.tokens,row.by,row.count]),[
    ['glm-5.4',300,{claude:300},9],
    ['gpt-6.2-sol',150,{codex:150},5],
    ['glm-5.3',25,{codex:20,claude:5},2],
  ]);
  assert.deepEqual(rows[1].writings,['gpt-6.2-sol','imported-2/gpt-6.2-sol']);assert.deepEqual(rows[2].names,{codex:['workbuddy/glm-5.3'],claude:['workbuddy/glm-5.3']});
  // Unmerged, each way of writing is a row of its own, and only agents that used it appear.
  const separate=rankModels([{agent:'codex',models:[model('gpt-6.2-sol',100,3),model('imported-2/gpt-6.2-sol',50,2)]}],false);
  assert.deepEqual(separate.map(row=>[row.title,row.by]),[['gpt-6.2-sol',{codex:100}],['imported-2/gpt-6.2-sol',{codex:50}]]);
});

test('the range before is as long as the selected one and ends where it starts',()=>{
  assert.deepEqual(previousRange({start:'2026-11-19T16:59',end:'2026-11-26T16:59'}),{start:'2026-11-12T16:59',end:'2026-11-19T16:59',length:7*1440*60000});
  assert.equal(previousRange({start:'2026-11-05T10:00',end:'2026-11-10T10:00'}).start,'2026-10-31T10:00');
  assert.equal(changePercent(150,100),50);assert.equal(changePercent(75,100),-25);assert.equal(changePercent(10,0),null);assert.equal(changePercent(null,10),null);
  assert.equal(zoneMinute(at('2026-11-20T00:00:00Z'),SH),'2026-11-20T08:00');
});

test('a range that is mostly empty at one end comes with the span that holds records',()=>{
  const list=bins(at('2026-11-19T12:00:00+08:00'),10,360);
  const result={bins:list,total_buckets:list.map((bin,i)=>({tokens:i<4?100:0}))};
  const tail=quietRange(result,SH);
  assert.equal(tail.side,'tail');assert.equal(tail.empty,6);
  assert.equal(tail.since,list[3].end_ms);
  assert.deepEqual([tail.start,tail.end],[zoneMinute(list[0].start_ms,SH),zoneMinute(list[4].end_ms,SH)]);
  const head=quietRange({bins:list,total_buckets:list.map((bin,i)=>({tokens:i>=6?100:0}))},SH);
  assert.equal(head.side,'head');assert.equal(head.since,list[6].start_ms);
  assert.deepEqual([head.start,head.end],[zoneMinute(list[5].start_ms,SH),zoneMinute(list[9].end_ms,SH)]);
  // Too little empty to matter, nothing at all, or no bins: no hint.
  assert.equal(quietRange({bins:list,total_buckets:list.map((bin,i)=>({tokens:i<7?100:0}))},SH),null);
  assert.equal(quietRange({bins:list,total_buckets:list.map(()=>({tokens:0}))},SH),null);
  assert.equal(quietRange(null,SH),null);assert.equal(quietRange({bins:list,total_buckets:[]},SH),null);
});

test('clock times are found in the statistics zone',()=>{
  assert.equal(zonedTime(SH,2026,11,20,0,0),at('2026-11-19T16:00:00Z'));
  assert.equal(roundUp(at('2026-11-19T16:59:00+08:00'),SH,1440),at('2026-11-20T00:00:00+08:00'));
  assert.equal(roundUp(at('2026-11-20T00:00:00+08:00'),SH,1440),at('2026-11-20T00:00:00+08:00'));
  assert.equal(roundUp(at('2026-11-20T03:01:00+08:00'),SH,360),at('2026-11-20T06:00:00+08:00'));
  // A zone that moves its clock: the next midnight is found on the wall clock.
  assert.equal(roundUp(at('2026-03-28T12:00:00+01:00'),'Europe/Berlin',1440),at('2026-03-29T00:00:00+01:00'));
  assert.equal(roundUp(at('2026-10-24T12:00:00+02:00'),'Europe/Berlin',1440),at('2026-10-25T00:00:00+02:00'));
});

test('time labels sit at the start of each day where the buckets allow it',()=>{
  const week=bins(at('2026-11-19T12:00:00+08:00'),30,360);
  const ticks=timeTicks(week,SH,1100);
  assert.deepEqual(ticks.map(tick=>tick.text),['11/20','11/21','11/22','11/23','11/24','11/25','11/26']);
  assert.equal(ticks[0].index,2,'the label is under the bucket that starts at midnight');assert.equal(ticks.at(-1).index,26);
  assert.equal(ticks[0].at,at('2026-11-20T00:00:00+08:00'));
});

test('bars that do not start at midnight still get the day they hold',()=>{
  // Thirty days in bars from six in the evening to six in the morning, and back.
  const month=bins(at('2026-10-27T18:00:00+08:00'),60,720);
  const ticks=timeTicks(month,SH,1100);
  assert.deepEqual(ticks.slice(0,3).map(tick=>[tick.index,tick.text]),[[0,'10/28'],[6,'10/31'],[12,'11/03']]);
  assert.ok(ticks.length<=14);
});

test('a short range is labelled by round hours, and a date at midnight',()=>{
  const day=bins(at('2026-11-25T17:00:00+08:00'),28,60);
  const ticks=timeTicks(day,SH,1100);
  assert.deepEqual(ticks.map(tick=>tick.text),['18:00','11/26','06:00','12:00','18:00']);
  assert.equal(ticks[1].index,7);
  assert.deepEqual(timeTicks([],SH,1100),[]);
});

test('on an axis a bucket that starts a day is named by its date alone',()=>{
  assert.equal(axisName(bins(at('2026-11-19T12:00:00+08:00'),3,720)[1],SH),'11/20');
  assert.equal(axisName(bins(at('2026-11-19T12:00:00+08:00'),3,720)[0],SH),'11/19 12:00');
  assert.equal(axisName({label:'11/20',start_ms:at('2026-11-19T16:00:00Z')},SH),'11/20');
});
