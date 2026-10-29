const test=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../public/queue');
function page({request=async()=>({filterId:'20741',name:'Test queue',issues:[],nextPageToken:null,syncedAt:'2026-10-29T10:00:00Z'}),openTicket=async()=>true}={}){
  const nodes=new Map();
  for(const id of ['queuePanel','queueRefresh','queueMore','queueCount','queueStatus','queueRows','queueEmpty','queueName','showQueue','hideQueue','queueOpenStatus','showMyQueue','queueTitleText','queueSource','showHardwareQueue'])nodes.set('#'+id,{hidden:false,textContent:'',innerHTML:'',listeners:{},attributes:{},classList:{toggle(){}},setAttribute(name,value){this.attributes[name]=value;},scrollIntoView(){},addEventListener(name,handler){this.listeners[name]=handler;}});
  const listeners={};let tick;
  const document={visibilityState:'visible',querySelector:selector=>nodes.get(selector),addEventListener:(name,handler)=>{listeners[name]=handler;}};
  const controller=create({document,request,openTicket,setInterval:(handler,delay)=>{assert.equal(delay,60000);tick=handler;}});
  return {nodes,document,listeners,controller,tick:()=>tick(),click:key=>nodes.get('#queueRows').listeners.click({target:{closest:()=>({dataset:{queueKey:key}})}})};
}
const issue=(key='ITSM-101')=>({key,title:'<script>Queue title</script>',status:'Open',priority:'High',created:'2026-10-29T01:00:00Z'});
const response=(issues,nextPageToken=null)=>({issues,filterId:'20741',name:'Unassigned tasks',nextPageToken,syncedAt:'2026-10-29T10:00:00Z'});
test('queue only polls while visible, refreshes on return and safely displays tickets',async()=>{
  let reads=0;
  const p=page({request:async()=>{reads++;return response([issue()]);}});
  await p.tick();assert.equal(reads,0);
  await p.controller.show();assert.equal(reads,1);
  assert(p.nodes.get('#queueRows').innerHTML.includes('&lt;script&gt;'));
  assert(!p.nodes.get('#queueRows').innerHTML.includes('<script>'));
  await p.tick();assert.equal(reads,2);
  p.document.visibilityState='hidden';await p.tick();assert.equal(reads,2);
  p.document.visibilityState='visible';await p.listeners.visibilitychange();assert.equal(reads,3);
  p.controller.hide();await p.tick();assert.equal(reads,3);
  assert.equal(p.nodes.get('#showQueue').attributes['aria-expanded'],'false');
});
test('queue paginates without duplicate tickets, refreshes from first page, retains stale rows on errors',async()=>{
  const calls=[];let fail=false;
  const p=page({request:async url=>{calls.push(url);if(fail)throw Error('Jira unavailable');return url.includes('cursor=')?response([issue(),issue('ITSM-202')]):response([issue()],'next/+');}});
  await p.controller.show();
  assert.equal(p.nodes.get('#queueCount').textContent,'1+');
  await p.nodes.get('#queueMore').onclick();
  assert.equal(calls[1],'/api/ticket/queue?cursor=next%2F%2B&filterId=20741');
  assert.equal(p.nodes.get('#queueCount').textContent,'2');
  assert.equal((p.nodes.get('#queueRows').innerHTML.match(/<tr>/g)||[]).length,2);
  fail=true;await p.controller.refresh();
  assert(p.nodes.get('#queueRows').innerHTML.includes('ITSM-202'));
  assert(p.nodes.get('#queueStatus').textContent.includes('last loaded queue'));
  fail=false;await p.controller.refresh();
  assert.equal(calls.at(-1),'/api/ticket/queue');
  assert.equal(p.nodes.get('#queueCount').textContent,'1+');
});
test('queue coalesces pending refreshes and only hides after a successful ticket open',async()=>{
  let resolve,reads=0,opens=0,success=false;
  const p=page({request:()=>{reads++;return new Promise(done=>{resolve=done;});},openTicket:async()=>{opens++;return success;}});
  const pending=p.controller.show();await p.tick();assert.equal(reads,1);
  resolve(response([issue()]));await pending;
  await p.click('ITSM-999');assert.equal(opens,0);
  await p.click('ITSM-101');assert.equal(opens,1);
  assert.equal(p.nodes.get('#queuePanel').hidden,false);
  assert(p.nodes.get('#queueOpenStatus').textContent.includes('Could not open'));
  success=true;await p.click('ITSM-101');assert.equal(p.nodes.get('#queuePanel').hidden,true);
});
test('empty queues and changed filters never merge incompatible pages',async()=>{
  let changed=false;
  const p=page({request:async()=>({...response([issue()],'next'),filterId:changed?'999':'20741'})});
  await p.controller.show();changed=true;await p.nodes.get('#queueMore').onclick();
  assert(p.nodes.get('#queueStatus').textContent.includes('filter changed'));
  assert.equal(p.nodes.get('#queueCount').textContent,'1+');
  const empty=page();await empty.controller.show();
  assert.equal(empty.nodes.get('#queueEmpty').hidden,false);
  assert.equal(empty.nodes.get('#queueMore').hidden,true);
});
test('switching queues isolates delayed results and uses the My tickets source and cursor',async()=>{
  let finish;
  const p=page({request:async url=>{
    if(url==='/api/ticket/queue')return new Promise(resolve=>{finish=resolve;});
    assert(url.includes('queue=mine'));return {...response([issue('ITSM-202')]),filterId:'20746',name:'My active tasks'};
  }});
  const pending=p.controller.show();
  await p.nodes.get('#showMyQueue').onclick();
  assert.equal(p.nodes.get('#queueTitleText').textContent,'My tickets');
  assert.equal(p.nodes.get('#queueSource').attributes.href.endsWith('59711'),true);
  assert(p.nodes.get('#queueRows').innerHTML.includes('Assigned to me'));
  assert(!p.nodes.get('#queueRows').innerHTML.includes('data-assign-key'));
  finish(response([issue('ITSM-101')]));await pending;
  assert(p.nodes.get('#queueRows').innerHTML.includes('ITSM-202'));
  assert(!p.nodes.get('#queueRows').innerHTML.includes('ITSM-101'));
});
test('Assign to me posts once, refreshes membership and keeps the queue open',async()=>{
  const calls=[];let finish,assigned=false;
  const p=page({request:async(url,options)=>{
    calls.push({url,options});
    if(options?.method==='POST')return new Promise(resolve=>{finish=()=>{assigned=true;resolve({changed:true,accountId:'me'});};});
    return response(assigned?[]:[issue()]);
  }});
  await p.controller.show();
  const click=()=>p.nodes.get('#queueRows').listeners.click({target:{closest:selector=>selector.includes('data-assign-key')?{dataset:{assignKey:'ITSM-101'}}:null}});
  const pending=click();await click();
  assert.equal(calls.filter(call=>call.options?.method==='POST').length,1);
  assert(p.nodes.get('#queueRows').innerHTML.includes('Assigning...'));
  finish();await pending;
  assert.equal(p.nodes.get('#queuePanel').hidden,false);
  assert.equal(p.nodes.get('#queueEmpty').hidden,false);
  assert(p.nodes.get('#queueOpenStatus').textContent.includes('assigned to you'));
  assert.equal(calls.at(-1).url,'/api/ticket/queue');
});
test('uncertain assignment keeps the row and blocks another write instead of claiming success',async()=>{
  let posts=0;
  const p=page({request:async(url,options)=>{
    if(options?.method==='POST'){posts++;throw Object.assign(Error('Check Jira before retrying'),{uncertain:true});}
    return response([issue()]);
  }});
  await p.controller.show();
  const click=()=>p.nodes.get('#queueRows').listeners.click({target:{closest:selector=>selector.includes('data-assign-key')?{dataset:{assignKey:'ITSM-101'}}:null}});
  await click();await click();assert.equal(posts,1);
  assert(p.nodes.get('#queueRows').innerHTML.includes('Check Jira'));
  assert(p.nodes.get('#queueRows').innerHTML.includes('ITSM-101'));
  assert(!p.nodes.get('#queueOpenStatus').textContent.includes('assigned to you'));
});

test('Hardware alerts switches to its own source, paginates, and closes without leaving navigation selected',async()=>{
  const calls=[];
  const p=page({request:async url=>{calls.push(url);return {...response([issue('ITSM-303')],url.includes('cursor=')?null:'hardware-next'),filterId:'hardware-filter',name:'Hardware alerts'};}});
  await p.nodes.get('#showHardwareQueue').onclick();
  assert.equal(p.nodes.get('#queueTitleText').textContent,'Hardware alerts');
  assert(p.nodes.get('#queueSource').attributes.href.endsWith('59736'));
  assert.equal(p.nodes.get('#showHardwareQueue').attributes['aria-expanded'],'true');
  assert.equal(p.nodes.get('#showMyQueue').attributes['aria-expanded'],'false');
  assert.equal(calls[0],'/api/ticket/queue?queue=hardware');
  assert(p.nodes.get('#queueRows').innerHTML.includes('data-assign-key="ITSM-303"'));
  await p.nodes.get('#queueMore').onclick();
  assert.equal(calls[1],'/api/ticket/queue?queue=hardware&cursor=hardware-next&filterId=hardware-filter');
  p.controller.hide();
  assert.equal(p.nodes.get('#showHardwareQueue').attributes['aria-expanded'],'false');
});
