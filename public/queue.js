(function(root){
  function create({document,request,openTicket,onAssigned=async()=>{},setInterval=root.setInterval}){
    const $=selector=>document.querySelector(selector);
    const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const states=new Map(['unassigned','mine','hardware'].map(id=>[id,{items:[],next:null,filterId:'',loading:false,loaded:false,syncedAt:'',error:'',notice:''}]));
    const uncertain=new Set();
    let active='unassigned',opening=false,assigning='';
    $('#queuePanel').hidden=true;
    function render(){
      const state=states.get(active),{items,next,filterId,loading,loaded,syncedAt,error}=state;
      const busy=opening||Boolean(assigning);
      $('#queueTitleText').textContent=active==='hardware'?'Hardware alerts':active==='mine'?'My tickets':'Live queue';
      $('#queueName').textContent=state.name||(active==='hardware'?'Hardware alerts':active==='mine'?'Your active tasks':'Active unassigned tasks');
      $('#queueSource').setAttribute('href','https://i3dnet.atlassian.net/jira/dashboards/12754?maximized='+(active==='hardware'?'59736':active==='mine'?'59711':'59715'));
      $('#queueRefresh').disabled=loading||Boolean(assigning);
      $('#queueMore').disabled=loading||Boolean(assigning);
      $('#queueMore').hidden=!next;
      $('#queueCount').textContent=loaded?String(items.length)+(next?'+':''):'';
      $('#queueStatus').textContent=error?(loaded?'Showing the last loaded queue. ':'')+error:loading?'Updating queue...':syncedAt?'Updated '+new Date(syncedAt).toLocaleTimeString()+' - Refreshes every 60s':'';
      $('#queueStatus').classList.toggle('queue-error',Boolean(error));
      $('#queueRows').innerHTML=items.map(issue=>{
        const date=Number.isFinite(Date.parse(issue.created))?new Date(issue.created).toLocaleDateString():'-';
        const disabled=busy||loading||uncertain.has(issue.key);
        const assignment=active==='mine'?'<span class="queue-assigned">Assigned to me</span>':issue.assigneeId?'<span class="queue-assigned">'+escape(issue.assignee||'Assigned')+'</span>':'<button type="button" class="queue-assign" data-assign-key="'+escape(issue.key)+'" aria-label="Assign '+escape(issue.key)+' to me" '+(disabled?'disabled':'')+'>'+(assigning===issue.key?'Assigning...':uncertain.has(issue.key)?'Check Jira':'Assign to me')+'</button>';
        return '<tr><td><button type="button" class="queue-open" data-queue-key="'+escape(issue.key)+'" '+(busy?'disabled':'')+'><span class="key">'+escape(issue.key)+'</span><span class="queue-summary">'+escape(issue.title)+'</span></button></td><td><span class="queue-status">'+escape(issue.status)+'</span></td><td>'+escape(issue.priority||'-')+'</td><td><time datetime="'+escape(issue.created)+'">'+escape(date)+'</time></td><td>'+assignment+'</td></tr>';
      }).join('');
      $('#queueEmpty').hidden=items.length>0||!loaded;
      $('#queueEmpty').textContent='No tickets in this queue.';
      $('#queueOpenStatus').textContent=state.notice;
    }
    async function refresh({more=false,queue=active}={}){
      const state=states.get(queue);
      if(state.loading)return;
      state.loading=true;state.error='';if(active===queue)render();
      try{
        const query=[];
        if(queue!=='unassigned')query.push('queue='+encodeURIComponent(queue));
        if(more&&state.next)query.push('cursor='+encodeURIComponent(state.next),'filterId='+encodeURIComponent(state.filterId));
        const result=await request('/api/ticket/queue'+(query.length?'?'+query.join('&'):''));
        if(!Array.isArray(result.issues))throw Error('The queue response was invalid.');
        if(more&&result.filterId!==state.filterId)throw Error('The queue filter changed. Refresh the queue.');
        const unique=new Map((more?state.items:[]).map(issue=>[issue.key,issue]));
        for(const issue of result.issues)if(/^[A-Z][A-Z0-9]+-\d+$/i.test(issue.key))unique.set(issue.key,issue);
        state.items=[...unique.values()];state.next=result.nextPageToken||null;state.filterId=result.filterId;
        state.syncedAt=result.syncedAt;state.loaded=true;state.name=result.name;
      }catch(failure){state.error=failure.message||'Could not refresh the queue.';}
      finally{state.loading=false;if(active===queue)render();}
    }
    function hide(){
      $('#queuePanel').hidden=true;
      for(const id of ['#showQueue','#showMyQueue','#showHardwareQueue'])$(id).setAttribute('aria-expanded','false');
    }
    function show(queue='unassigned'){
      active=queue;
      $('#queuePanel').hidden=false;
      $('#showQueue').setAttribute('aria-expanded',String(queue==='unassigned'));
      $('#showMyQueue').setAttribute('aria-expanded',String(queue==='mine'));
      $('#showHardwareQueue').setAttribute('aria-expanded',String(queue==='hardware'));
      render();$('#queuePanel').scrollIntoView?.({block:'start'});
      return refresh();
    }
    $('#showQueue').onclick=()=>!$('#queuePanel').hidden&&active==='unassigned'?hide():show('unassigned');
    $('#showMyQueue').onclick=()=>!$('#queuePanel').hidden&&active==='mine'?hide():show('mine');
    $('#showHardwareQueue').onclick=()=>!$('#queuePanel').hidden&&active==='hardware'?hide():show('hardware');
    $('#hideQueue').onclick=hide;
    $('#queueRefresh').onclick=()=>refresh();
    $('#queueMore').onclick=()=>refresh({more:true});
    $('#queueRows').addEventListener('click',async event=>{
      const state=states.get(active);
      const assignButton=event.target.closest?.('button[data-assign-key]');
      const assignKey=assignButton?.dataset.assignKey;
      if(assignKey){
        const issue=state.items.find(item=>item.key===assignKey);
        if(!issue||active==='mine'||issue.assigneeId||assigning||opening||state.loading||uncertain.has(assignKey))return;
        assigning=assignKey;state.notice='Assigning '+assignKey+' to you...';render();
        try{
          const receipt=await request('/api/ticket/'+encodeURIComponent(assignKey)+'/assign-to-me',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
          state.notice=assignKey+' is assigned to you.';
          const unassigned=states.get('unassigned');
          unassigned.items=unassigned.items.filter(item=>item.key!==assignKey);
          // Read fresh membership from Jira when either queue is next shown.
          try{await onAssigned(assignKey,receipt);}catch{state.notice+=' Refresh the open ticket to update its details.';}
          await refresh({queue:active});
        }catch(failure){
          state.notice=failure.message||'Could not assign this ticket.';
          if(failure.uncertain)uncertain.add(assignKey);
        }finally{assigning='';render();}
        return;
      }
      const button=event.target.closest?.('button[data-queue-key]');
      const key=button?.dataset.queueKey;
      if(opening||assigning||!state.items.some(issue=>issue.key===key))return;
      opening=true;state.notice='Opening '+key+'...';render();
      try{
        if(await openTicket(key)){hide();state.notice='';}
        else state.notice='Could not open '+key+'. Your current ticket is kept. Try again.';
      }catch(failure){state.notice=failure.message||'Could not open this ticket.';}
      finally{opening=false;render();}
    });
    const live=()=>{if(!assigning&&!$('#queuePanel').hidden&&document.visibilityState!=='hidden')return refresh();};
    setInterval(live,60000);
    document.addEventListener('visibilitychange',live);
    render();
    return {show,hide,refresh};
  }
  if(typeof module==='object'&&module.exports)module.exports={create};else root.AetherQueue={create};
})(typeof window!=='undefined'?window:globalThis);