const test=require('node:test');
const assert=require('node:assert/strict');
const {createMotion,mount,frameSize}=require('../public/brand-duck');
test('duck remains confined throughout every behaviour and when its banner shrinks',()=>{
  let seed=42;const random=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296);
  const motion=createMotion({width:180,height:48,random}),actions=new Set();
  for(let i=0;i<12000;i++){
    const state=motion.step(50);actions.add(state.action);
    assert(state.x>=0&&state.x<=180-frameSize);assert(state.y>=0&&state.y<=48-frameSize);
    assert(state.row>=0&&state.row<17);
    const count=[4,4,6,6,4,4,4,4,4,4,4,10,10,15,15,5,5][state.row];
    assert(state.column>=0&&state.column<count);
  }
  for(const action of ['walking','turning','eating','sleeping','flying','jumping','looking around'])assert(actions.has(action),action);
  motion.resize(70,40);
  for(let i=0;i<1000;i++){const state=motion.step(50);assert(state.x>=0&&state.x<=30);assert.equal(state.y,0);}
});
test('duck pauses while hidden, rests for reduced motion and resumes without duplicate animation loops',()=>{
  const stage={clientWidth:180,clientHeight:48},sprite={style:{}},listeners={},mediaListeners={};
  const callbacks=new Map();let id=0;
  const preference={matches:false,addEventListener:(name,handler)=>{mediaListeners[name]=handler;}};
  const document={visibilityState:'visible',querySelector:selector=>selector==='#brandDuckHabitat'?stage:sprite,addEventListener:(name,handler)=>{listeners[name]=handler;}};
  mount({document,requestAnimationFrame:callback=>{callbacks.set(++id,callback);return id;},cancelAnimationFrame:key=>callbacks.delete(key),matchMedia:()=>preference});
  assert.equal(callbacks.size,1);
  document.visibilityState='hidden';listeners.visibilitychange();assert.equal(callbacks.size,0);
  document.visibilityState='visible';listeners.visibilitychange();assert.equal(callbacks.size,1);
  listeners.visibilitychange();assert.equal(callbacks.size,1);
  preference.matches=true;mediaListeners.change();assert.equal(callbacks.size,0);assert.equal(sprite.style.backgroundPosition,'0px -280px');
  preference.matches=false;mediaListeners.change();assert.equal(callbacks.size,1);
});