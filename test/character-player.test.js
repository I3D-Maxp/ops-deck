const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {clips,createPlayer,mount}=require('../public/character-player');
test('all six character sheets match their four-frame dimensions',()=>{
  assert.equal(clips.length,6);
  for(const clip of clips){
    const image=fs.readFileSync(path.join(__dirname,'../animations',clip.file));
    assert.equal(image.readUInt32BE(16),clip.width*3);
    assert.equal(image.readUInt32BE(20),clip.height*2);
  }
});
test('characters advance every five minutes, wrap after six, and clicks reset the phase and charge',()=>{
  let time=0;const player=createPlayer({now:()=>time});
  assert.equal(player.state().index,0);
  time=299999;assert.equal(player.state().index,0);assert(player.state().progress>.99);
  time=300000;assert.equal(player.state().index,1);assert.equal(player.state().progress,0);
  assert.equal(player.state().frame,3);
  time+=150;assert.equal(player.state().frame,2);
  time+=150;assert.equal(player.state().frame,1);
  time+=150;assert.equal(player.state().frame,0);
  const clicked=player.next();assert.equal(clicked.index,2);assert.equal(clicked.progress,0);
  time+=299999;assert.equal(player.state().index,2);
  time++;assert.equal(player.state().index,3);
  time+=3*300000;assert.equal(player.state().index,0);
});
test('character click updates its image and charge, and hidden-tab return follows elapsed time',()=>{
  const nodes=new Map(['characterCycle','characterSprite','characterCharge','characterChargeFill'].map(id=>['#'+id,{style:{},setAttribute(){}}]));
  const listeners={},document={visibilityState:'visible',querySelector:key=>nodes.get(key),addEventListener:(name,handler)=>{listeners[name]=handler;}};
  let time=0,tick;
  mount({document,now:()=>time,setInterval:handler=>{tick=handler;},matchMedia:()=>({matches:false,addEventListener(){}})});
  time=150000;tick();assert.equal(nodes.get('#characterChargeFill').style.transform,'scaleX(0.5)');
  nodes.get('#characterCycle').onclick();
  assert(nodes.get('#characterSprite').style.backgroundImage.includes('unit_magic_atk_208002507'));
  assert.equal(nodes.get('#characterChargeFill').style.transform,'scaleX(0)');
  assert.equal(nodes.get('#characterSprite').style.backgroundPosition,'0px -83px');
  document.visibilityState='hidden';time+=600000;tick();
  assert(nodes.get('#characterSprite').style.backgroundImage.includes('208002507'));
  document.visibilityState='visible';listeners.visibilitychange();
  assert(nodes.get('#characterSprite').style.backgroundImage.includes('unit_magic_atk_208001007'));
});