import test from 'node:test';
import assert from 'node:assert/strict';
import {formatTime, rangeLabel} from '../web/src/content/dashboard/time-format.js';

const bin={start:'2026-11-25T11:00:00Z',end:'2026-11-25T19:00:00Z',partial:false};

test('times are written as wall clock in the statistics zone',()=>{
  assert.equal(formatTime(bin.start,'Asia/Shanghai'),'2026/11/25 19:00');
  assert.equal(formatTime(bin.start,'UTC'),'2026/11/25 11:00');
  assert.equal(formatTime(bin.start,'America/New_York'),'2026/11/25 06:00');
  // Midnight is the first hour of the next day, never "24:00".
  assert.equal(formatTime('2026-11-25T16:00:00Z','Asia/Shanghai'),'2026/11/26 00:00');
  // The same zone asked for repeatedly reuses one formatter.
  for(let i=0;i<40;i+=1)assert.equal(formatTime(bin.start,'Asia/Shanghai'),'2026/11/25 19:00');
});

test('a timestamp that needs its exact moment keeps seconds and milliseconds',()=>{
  assert.equal(formatTime('2026-11-25T11:00:00.250Z','UTC',true),'2026/11/25 11:00:00.250');
  assert.equal(formatTime('2026-11-25T11:00:07.100Z','Asia/Shanghai',true),'2026/11/25 19:00:07.100');
  // The plain form of the same zone is unaffected by the precise one.
  assert.equal(formatTime(bin.start,'UTC'),'2026/11/25 11:00');
});

test('a bar heading names the whole span the bar stands for',()=>{
  assert.equal(rangeLabel(bin,'UTC'),'2026/11/25 11:00 ～ 2026/11/25 19:00');
  assert.equal(rangeLabel(bin,'Asia/Shanghai'),'2026/11/25 19:00 ～ 2026/11/26 03:00');
});

test('a bar cut short by the selected range says so',()=>{
  const first={...bin,partial:true};
  assert.equal(rangeLabel(first,'UTC'),'2026/11/25 11:00 ～ 2026/11/25 19:00 · 部分时段');
  // A merged overview bar is partial when any of the bars it merges is.
  const merged={...bin,partial:bin.partial||true};
  assert.equal(rangeLabel(merged,'UTC'),'2026/11/25 11:00 ～ 2026/11/25 19:00 · 部分时段');
  // The note does not depend on the input being mutated.
  assert.equal(bin.partial,false);
});
