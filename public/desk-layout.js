(function(root){
  const ids=['import','ticket','draft'];
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  function normalize(layout){
    const clean={};
    for(const id of ids){
      const entry=layout&&(layout[id]||(id==='draft'?layout.comments:null));
      if(!entry||!['x','y','z'].every(key=>typeof entry[key]==='number'&&Number.isFinite(entry[key])))continue;
      clean[id]={x:clamp(entry.x,0,10000),y:clamp(entry.y,0,10000),z:clamp(Math.round(entry.z),1,ids.length),minimized:entry.minimized===true&&!(id==='draft'&&layout.comments&&layout.comments.minimized!==true)};
    }
    return clean;
  }
  function defaults(width,importHeight=155,ticketHeight=420,draftHeight=500){
    const wide=width>=740;
    const ticketWidth=wide?Math.floor((width-16)*.56):width;
    const draftWidth=wide?width-ticketWidth-16:Math.min(430,width);
    const rowY=importHeight+18;
    return {
      import:{x:0,y:0,z:1,width:Math.min(390,width)},
      ticket:{x:0,y:rowY,z:2,width:ticketWidth},
      draft:{x:wide?ticketWidth+16:0,y:wide?rowY:rowY+ticketHeight+18,z:3,width:draftWidth}
    };
  }
  function create({canvas,modules,layout={},onChange=()=>{}}){
    let state=normalize(layout);
    let drag=null;
    let resizePending=false;
    const byId=new Map(modules.map(module=>[module.id,module]));
    const snapshot=()=>Object.fromEntries(ids.map(id=>[id,{...state[id]}]));
    function changed(){onChange(snapshot());}
    function paint(){
      let bottom=580;
      for(const {id,element,toggle,name}of modules){
        const position=state[id];
        element.classList.toggle('is-minimized',position.minimized);
        if(toggle){toggle.textContent=position.minimized?'+':'-';toggle.setAttribute('aria-expanded',String(!position.minimized));toggle.setAttribute('aria-label',(position.minimized?'Restore ':'Minimize ')+name);toggle.title=(position.minimized?'Restore ':'Minimize ')+name;}
        element.style.left=position.x+'px';element.style.top=position.y+'px';element.style.zIndex=String(position.z);
        bottom=Math.max(bottom,position.y+element.offsetHeight+36);
      }
      canvas.style.minHeight=bottom+'px';
    }
    function reflow(reset=false){
      const width=Math.max(1,canvas.clientWidth);
      const sizes=defaults(width);
      for(const {id,element}of modules)element.style.width=sizes[id].width+'px';
      const starting=defaults(width,byId.get('import').element.offsetHeight,byId.get('ticket').element.offsetHeight,byId.get('draft').element.offsetHeight);
      for(const {id,element}of modules){
        const position=!reset&&state[id]?state[id]:starting[id];
        state[id]={x:clamp(position.x,0,Math.max(0,width-element.offsetWidth)),y:clamp(position.y,0,10000),z:position.z,minimized:position.minimized===true};
      }
      paint();
    }
    function raise(id,save=true){
      if(!state[id])return;
      const order=ids.filter(key=>key!==id).sort((a,b)=>state[a].z-state[b].z).concat(id);
      let updated=false;
      order.forEach((key,index)=>{if(state[key].z!==index+1)updated=true;state[key].z=index+1;});
      paint();
      if(save&&updated)changed();
    }
    function reveal(id){
      const module=byId.get(id);if(!module)return;
      const minimized=state[id].minimized;
      state[id].minimized=false;
      raise(id);
      if(minimized)changed();
      module.handle.scrollIntoView({block:'center',inline:'nearest'});
      module.handle.focus({preventScroll:true});
    }
    function coordinate(event,key){return event['page'+key]??event['client'+key];}
    function finish(event){
      if(!drag||event.pointerId!==drag.pointer)return;
      const {id,pointer}=drag;drag=null;
      const {element,handle}=byId.get(id);
      element.classList.remove('is-dragging');
      if(handle.hasPointerCapture(pointer))handle.releasePointerCapture(pointer);
      changed();
    }
    for(const {id,element,handle,toggle}of modules){
      if(toggle)toggle.onclick=event=>{event.stopPropagation();state[id].minimized=!state[id].minimized;raise(id,false);paint();changed();};
      element.addEventListener('pointerdown',()=>raise(id));
      element.addEventListener('focusin',()=>raise(id));
      handle.addEventListener('pointerdown',event=>{
        if(event.button!==0||event.isPrimary===false||drag)return;
        event.preventDefault();event.stopPropagation();
        raise(id,false);
        drag={id,pointer:event.pointerId,x:coordinate(event,'X'),y:coordinate(event,'Y'),start:{...state[id]}};
        handle.setPointerCapture(event.pointerId);
        element.classList.add('is-dragging');handle.focus({preventScroll:true});
      });
      handle.addEventListener('pointermove',event=>{
        if(!drag||drag.id!==id||drag.pointer!==event.pointerId)return;
        const width=canvas.clientWidth;
        state[id].x=clamp(drag.start.x+coordinate(event,'X')-drag.x,0,Math.max(0,width-element.offsetWidth));
        state[id].y=clamp(drag.start.y+coordinate(event,'Y')-drag.y,0,10000);
        paint();
      });
      for(const name of ['pointerup','pointercancel','lostpointercapture'])handle.addEventListener(name,finish);
      handle.addEventListener('keydown',event=>{
        const movement={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
        if(!movement)return;
        event.preventDefault();raise(id,false);
        const step=event.shiftKey?1:10;
        state[id].x=clamp(state[id].x+movement[0]*step,0,Math.max(0,canvas.clientWidth-element.offsetWidth));
        state[id].y=clamp(state[id].y+movement[1]*step,0,10000);
        paint();changed();
      });
    }
    reflow();
    function queueReflow(){
      if(resizePending)return;
      resizePending=true;
      (root.requestAnimationFrame||((callback)=>setTimeout(callback,0)))(()=>{resizePending=false;reflow();});
    }
    if(typeof root.ResizeObserver==='function'){
      const observer=new root.ResizeObserver(queueReflow);
      observer.observe(canvas);for(const {element}of modules)observer.observe(element);
    }
    root.addEventListener?.('resize',queueReflow);
    return {snapshot,reveal,reflow,restore(layout){state=normalize(layout);reflow();},reset(){reflow(true);changed();}};
  }
  const api={create,normalize,defaults};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.AetherLayout=api;
})(typeof window!=='undefined'?window:globalThis);
