(function(root){
  const clips=[
    {file:'unit_magic_standby_208002507.png',width:73,height:106,kind:'standby',label:'Squall - magic standby'},
    {file:'unit_magic_atk_208002507.png',width:107,height:83,kind:'attack',label:'Squall - magic attack',reverse:true},
    {file:'unit_magic_standby_208001007.png',width:68,height:73,kind:'standby',label:'208001007 - magic standby'},
    {file:'unit_magic_atk_208001007.png',width:84,height:74,kind:'attack',label:'208001007 - magic attack',reverse:true},
    {file:'unit_magic_standby_208002807.png',width:81,height:94,kind:'standby',label:'208002807 - magic standby'},
    {file:'unit_magic_atk_208002807.png',width:122,height:85,kind:'attack',label:'208002807 - magic attack',reverse:true}
  ];
  function createPlayer({sequence=clips,phaseMs=300000,frameMs=150,now=()=>performance.now()}={}){
    let index=0,start=now();
    function state(time=now()){
      const elapsed=Math.max(0,time-start);
      const advances=Math.floor(elapsed/phaseMs);
      if(advances){index=(index+advances)%sequence.length;start+=advances*phaseMs;}
      const age=Math.max(0,time-start),clip=sequence[index];
      const frame=Math.floor(age/frameMs)%4;
      return {index,clip,frame:clip.reverse?3-frame:frame,progress:age/phaseMs};
    }
    return {state,next(){const current=state();index=(current.index+1)%sequence.length;start=now();return state(start);}};
  }
  function mount({document,setInterval,now,matchMedia,ImageCtor=root.Image}){
    const button=document.querySelector('#characterCycle'),sprite=document.querySelector('#characterSprite'),fill=document.querySelector('#characterChargeFill'),charge=document.querySelector('#characterCharge');
    if(!button||!sprite||!fill||!charge)return;
    const player=createPlayer({now});
    const preference=matchMedia?.('(prefers-reduced-motion: reduce)');
    let displayed=-1;
    if(typeof ImageCtor==='function')for(const clip of clips){const image=new ImageCtor();image.src='/animations/'+clip.file;}
    function paint(state=player.state()){
      const {clip,index,progress}=state;
      if(index!==displayed){
        sprite.style.width=clip.width+'px';sprite.style.height=clip.height+'px';
        sprite.style.backgroundImage='url("/animations/'+clip.file+'")';
        sprite.style.backgroundSize=clip.width*3+'px '+clip.height*2+'px';
        button.title=clip.label+' ('+(index+1)+'/'+clips.length+'). Click for next animation.';
        button.setAttribute('aria-label',button.title);
        charge.style.filter=clip.kind==='attack'?'hue-rotate(65deg)':'none';
        displayed=index;
      }
      const frame=preference?.matches?0:state.frame;
      sprite.style.backgroundPosition=-(frame%3)*clip.width+'px '+-Math.floor(frame/3)*clip.height+'px';
      fill.style.transform='scaleX('+progress+')';
      charge.style.boxShadow=progress>.85?'0 0 10px #64e5e066':'0 0 3px #64e5e01a';
    }
    button.onclick=()=>paint(player.next());
    setInterval(()=>{if(document.visibilityState!=='hidden')paint();},150);
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='hidden')paint();});
    preference?.addEventListener?.('change',()=>paint());
    paint();
    return player;
  }
  const api={clips,createPlayer,mount};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else{root.AetherCharacters=api;mount({document:root.document,setInterval:root.setInterval.bind(root),now:()=>root.performance.now(),matchMedia:root.matchMedia?.bind(root)});}
})(typeof window!=='undefined'?window:globalThis);