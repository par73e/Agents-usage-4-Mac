import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutRangeSliderLabels} from '../web/src/components/slider-math.js';

// The display-range slider as it is on the page: the control, a time such as "11/27 18:00"
// and the inline label "显示范围".
const WIDTH=1204,TIME=81,LABEL=56,GAP=12;

// Where the rule puts the two values, the label when there is one, and the thumbs.
function placed(startPercent,endPercent,{label=LABEL,width=WIDTH}={}){
  const rule=layoutRangeSliderLabels({width,startPercent,endPercent,lowerWidth:TIME,upperWidth:TIME,inlineLabelWidth:label});
  return {...rule,lower:[rule.lowerLeft,rule.lowerLeft+TIME],upper:[rule.upperLeft,rule.upperLeft+TIME],
    label:label?[8,8+label]:null,thumbs:[width*startPercent/100,width*endPercent/100]};
}
const apart=(a,b,gap=GAP)=>a[1]+gap<=b[0]+1e-6||b[1]+gap<=a[0]+1e-6;
const leftOf=(box,thumb)=>box[1]+GAP<=thumb+1e-6;
const rightOf=(box,thumb)=>box[0]-GAP>=thumb-1e-6;
// A value is never written under a thumb: it stands clear of both, or between them with a gap from each.
const clearOfThumbs=(box,[lower,upper])=>leftOf(box,lower)||rightOf(box,upper)||(box[0]>=lower+GAP-1e-6&&leftOf(box,upper));
const within=state=>state.lower[0]>=0&&state.upper[1]<=WIDTH;

test('a narrow range at either end keeps the two times apart',()=>{
  for(const [start,end] of [[93,100],[90,96],[92,95],[100,100],[0,7],[3,11],[4,9],[0,12]]){
    const state=placed(start,end);
    assert.ok(apart(state.lower,state.upper),`${start}–${end}: the lower time ${state.lower} meets the upper ${state.upper}`);
    assert.ok(apart(state.label,state.lower),`${start}–${end}: the label meets the lower time`);
    assert.ok(within(state),`${start}–${end}: a time runs past the control`);
    assert.ok(clearOfThumbs(state.lower,state.thumbs)&&clearOfThumbs(state.upper,state.thumbs),`${start}–${end}: a time is written under a thumb`);
  }
});

test('thumbs close together at one end: both times stand on the other side, in their order',()=>{
  const end=placed(93,100);
  assert.deepEqual([end.lowerPlacement,end.upperPlacement],['outside','outside']);
  assert.ok(leftOf(end.upper,end.thumbs[0]),'the upper time ends before the lower thumb');
  assert.ok(apart(end.lower,end.upper));
  const start=placed(0,7);
  assert.ok(rightOf(start.lower,start.thumbs[1]),'the lower time begins after the upper thumb');
  assert.ok(apart(start.lower,start.upper));
  // Before, the lower time stood left of its thumb and the upper one came back over it.
  const before={lower:[1119.72-12-81,1119.72-12],upper:[1204-12-81,1204-12]};
  assert.ok(!apart(before.lower,before.upper),'the old positions did meet');
});

test('a range in the middle keeps both times outside its thumbs',()=>{
  for(const [start,end] of [[45,52],[50,52],[50,51],[20,28],[70,78]]){
    const state=placed(start,end);
    assert.deepEqual([state.lowerPlacement,state.upperPlacement],['outside','outside']);
    assert.ok(leftOf(state.lower,state.thumbs[0]),`${start}–${end}: the lower time is not left of its thumb`);
    assert.ok(rightOf(state.upper,state.thumbs[1]),`${start}–${end}: the upper time is not right of its thumb`);
  }
});

test('a wide range and one thumb kept still are laid out as before',()=>{
  const whole=placed(0,100);
  assert.deepEqual([whole.lowerPlacement,whole.upperPlacement],['inside','inside']);
  assert.deepEqual([whole.lower,whole.upper],[[76,157],[1111,1192]]);
  const to=placed(0,30);
  assert.deepEqual([to.lowerPlacement,to.upperPlacement],['inside','outside']);
  assert.deepEqual([to.lower,to.upper],[[76,157],[WIDTH*0.30+GAP,WIDTH*0.30+GAP+TIME]]);
});

test('without the inline label the rule holds as well',()=>{
  const start=placed(0,7,{label:0});
  assert.ok(rightOf(start.lower,start.thumbs[1])&&apart(start.lower,start.upper));
  const end=placed(93,100,{label:0});
  assert.ok(leftOf(end.upper,end.thumbs[0])&&apart(end.lower,end.upper));
  const short=placed(0,12,{label:0});
  assert.deepEqual([short.lowerPlacement,short.upperPlacement],['inside','outside']);
  assert.ok(apart(short.lower,short.upper));
});

test('wherever the thumbs are, no two of the three ever meet and no time is written under a thumb',()=>{
  let checked=0;
  for(let start=0;start<=100;start++)for(let end=start;end<=100;end++)for(const label of [0,LABEL]){
    const state=placed(start,end,{label});checked++;
    assert.ok(apart(state.lower,state.upper),`${start}–${end}, label ${label}: ${state.lowerPlacement}/${state.upperPlacement} ${state.lower} ${state.upper}`);
    if(label)assert.ok(apart(state.label,state.lower),`${start}–${end}: the label meets the lower time`);
    assert.ok(within(state),`${start}–${end}: a time runs past the control`);
    assert.ok(clearOfThumbs(state.lower,state.thumbs),`${start}–${end}, label ${label}: the lower time is under a thumb`);
    assert.ok(clearOfThumbs(state.upper,state.thumbs),`${start}–${end}, label ${label}: the upper time is under a thumb`);
  }
  assert.ok(checked>5000);
});
