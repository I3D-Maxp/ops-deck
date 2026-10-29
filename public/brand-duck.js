(function(root){
  const frameSize=40;
  function createMotion({width=180,height=48,random=Math.random}={}){
    let direction=1,x=8,y=0,phase=null,elapsed=0,bounce=0,previousDirection=1;
    const queue=[];
    const clamp=(value,max)=>Math.max(0,Math.min(Math.max(0,max),value));
    const duration=(min,max)=>min+random()*(max-min);
    const row=(right,left)=>()=>direction===1?right:left;
    const clip=(action,spriteRow,frames,ms,move=0,fly=false)=>({action,row:spriteRow,frames,ms,move,fly});
    const rise=()=>clip('getting up',row(0,1),[0,1,2,3],480);
    function plan(action){
      if(action==='walk')queue.push(clip('walking',row(5,6),[0,1,2,3],duration(2500,5500),18));
      else if(action==='eat')queue.push(clip('eating',row(15,16),[0],120),clip('eating',row(15,16),[1,2,3,2],duration(2200,4000)),clip('eating',row(15,16),[4],180));
      else if(action==='rest')queue.push(clip('sitting down',row(9,10),[0,1,2,3],480),clip('looking around',row(7,8),[0,1,2,3,2,1],duration(3000,6000)),rise());
      else if(action==='sleep')queue.push(clip('falling asleep',row(13,14),[0,1,2,3,4,5],900),clip('sleeping',row(13,14),[6,7,8,9,10,9,8,7],duration(9000,15000)),clip('waking up',row(13,14),[11,12,13,14],700));
      else if(action==='fly')queue.push(clip('taking off',row(11,12),[0,1,2,3],520),clip('flying',row(11,12),[4,5,6,7],duration(1800,3000),24,true),clip('landing',row(11,12),[8,9],400));
      else if(action==='hop')queue.push(clip('jumping',row(2,3),[0,1,2,3,4,5],720));
      else queue.push(clip('standing',row(0,1),[3],duration(1200,2400)));
      queue.push(clip('standing',row(0,1),[3],duration(700,1800)));
    }
    function next(){
      if(!queue.length){
        const actions=['walk','walk','eat','rest','sleep','hop','fly'];
        plan(actions[Math.min(actions.length-1,Math.floor(random()*actions.length))]);
      }
      phase=queue.shift();elapsed=0;
    }
    queue.push(rise());next();
    function snapshot(){
      const ground=Math.max(0,height-frameSize);
      y=phase.fly?Math.max(0,ground-5-Math.sin(elapsed/180)*2):ground;
      if(bounce>0){
        const index=Math.min(3,Math.floor((360-bounce)/90));
        return {x,y:ground,row:4,column:previousDirection===1?index:3-index,action:'turning'};
      }
      const nonLoop=['getting up','sitting down','falling asleep','waking up','taking off','landing','jumping'].includes(phase.action);
      const step=nonLoop?Math.min(phase.frames.length-1,Math.floor(elapsed/phase.ms*phase.frames.length)):Math.floor(elapsed/140)%phase.frames.length;
      return {x,y,row:phase.row(),column:phase.frames[step],action:phase.action};
    }
    return {
      step(ms){
        const delta=Math.max(0,Math.min(ms,100));
        if(bounce>0){bounce=Math.max(0,bounce-delta);return snapshot();}
        elapsed+=delta;
        if(phase.move){
          const max=Math.max(0,width-frameSize);
          x+=direction*phase.move*delta/1000;
          if(x<0||x>max){x=clamp(x,max);previousDirection=direction;direction*=-1;if(!phase.fly)bounce=360;}
        }
        if(elapsed>=phase.ms)next();
        return snapshot();
      },
      resize(nextWidth,nextHeight){width=Math.max(0,nextWidth);height=Math.max(0,nextHeight);x=clamp(x,width-frameSize);return snapshot();},
      rest(){return {x:clamp(x,width-frameSize),y:Math.max(0,height-frameSize),row:7,column:0,action:'resting'};}
    };
  }
  function mount({document,requestAnimationFrame,cancelAnimationFrame,matchMedia,ResizeObserver}){
    const stage=document.querySelector('#brandDuckHabitat'),sprite=document.querySelector('#brandDuckSprite');
    if(!stage||!sprite)return;
    const motion=createMotion({width:stage.clientWidth,height:stage.clientHeight});
    const preference=matchMedia?.('(prefers-reduced-motion: reduce)');
    let frame=null,previous=null,position='';
    function paint(state){
      sprite.style.transform='translate('+state.x.toFixed(2)+'px,'+state.y.toFixed(2)+'px)';
      const next=(-state.column*frameSize)+'px '+(-state.row*frameSize)+'px';
      if(next!==position){sprite.style.backgroundPosition=next;position=next;}
    }
    function tick(time){
      frame=null;
      if(document.visibilityState==='hidden'||preference?.matches){previous=null;return;}
      paint(motion.step(previous===null?0:time-previous));previous=time;
      frame=requestAnimationFrame(tick);
    }
    function resume(){
      if(frame!==null)cancelAnimationFrame(frame);
      frame=null;previous=null;
      if(preference?.matches){paint(motion.rest());return;}
      if(document.visibilityState!=='hidden')frame=requestAnimationFrame(tick);
    }
    if(ResizeObserver)new ResizeObserver(()=>paint(motion.resize(stage.clientWidth,stage.clientHeight))).observe(stage);
    preference?.addEventListener?.('change',resume);
    document.addEventListener('visibilitychange',resume);
    paint(motion.rest());resume();
  }
  const api={createMotion,mount,frameSize};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else{root.AetherDuck=api;mount({document:root.document,requestAnimationFrame:root.requestAnimationFrame.bind(root),cancelAnimationFrame:root.cancelAnimationFrame.bind(root),matchMedia:root.matchMedia?.bind(root),ResizeObserver:root.ResizeObserver});}
})(typeof window!=='undefined'?window:globalThis);