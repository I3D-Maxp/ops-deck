const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const {createSessionStore} = require('../session-store');
const format = require('../public/session-format');
const workflow = require('../public/workflow');
const project = path.resolve(__dirname,'..');
function snapshot(overrides={}) {
  return {version:1,savedAt:'2026-10-27T01:00:00.000Z',tabs:[{label:'AMS follow-up',ticket:{key:'ITSM-101',title:'Disk replacement'}}],drafts:{'ITSM-101':{customer:'Customer update',work:'Internal findings',mode:'work'}},tools:[{name:'Custom tool',url:'https://example.com',icon:'Link'}],currentTicket:{key:'ITSM-101',title:'Disk replacement'},mode:'work',inputs:{jiraInput:'ITSM-101',raw:'Unfinished pasted content',tabLabel:'Label being edited'},...overrides};
}
function temporary(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aether-session-test-'));
  t.after(()=>{
    const target=path.resolve(directory);
    assert.equal(path.dirname(target),path.resolve(os.tmpdir()));
    assert(path.basename(target).startsWith('aether-session-test-'));
    fs.rmSync(target,{recursive:true,force:true});
  });
  return directory;
}
test('disk session survives a fresh Node process, with all ticket state',t=>{
  const directory=temporary(t);
  createSessionStore(directory).write(snapshot());
  const result=spawnSync(process.execPath,['-e',"const store=require(process.argv[1]).createSessionStore(process.argv[2]);process.stdout.write(JSON.stringify(store.read()));",path.join(project,'session-store.js'),directory],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  const restored=JSON.parse(result.stdout);
  assert.deepEqual(restored.session,JSON.parse(JSON.stringify(format.validate(snapshot()))));
  assert.equal(restored.recovered,false);
});
test('damaged latest file recovers the previous save without overwriting it',t=>{
  const directory=temporary(t),store=createSessionStore(directory);
  store.write(snapshot());
  store.write(snapshot({savedAt:'2026-10-27T02:00:00.000Z',mode:'customer'}));
  fs.writeFileSync(path.join(directory,'session.json'),'{interrupted');
  assert.equal(store.read().recovered,true);
  assert.equal(store.read().session.mode,'work');
  store.write(snapshot({savedAt:'2026-10-27T03:00:00.000Z'}));
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'session.previous.json'),'utf8')).savedAt,snapshot().savedAt);
});
test('invalid backup does not replace a good disk session',t=>{
  const directory=temporary(t),store=createSessionStore(directory);store.write(snapshot());
  assert.throws(()=>store.write({version:99}));
  assert.equal(store.read().session.currentTicket.key,'ITSM-101');
  assert.throws(()=>format.validate(snapshot({tools:[{name:'Bad',url:'javascript:alert(1)'}]})));
  const cleaned=format.validate({...snapshot(),JIRA_API_TOKEN:'should not be persisted'});
  assert.equal(cleaned.JIRA_API_TOKEN,undefined);
});
function browser({storage=new Map(),disk=null,diskFailure=false}={}) {
  const html=fs.readFileSync(path.join(project,'public/index.html'),'utf8');
  const nodes=new Map([...html.matchAll(/id="([^"]+)"/g)].map(match=>['#'+match[1],{
    value:'',innerHTML:'',textContent:'',style:{},listeners:{},clientWidth:900,offsetHeight:220,
    get offsetWidth(){return parseFloat(this.style.width)||300;},
    classList:{add(){},remove(){},toggle(){}},
    setAttribute(){},focus(){this.focused=true;},scrollIntoView(){this.revealed=true;},
    setPointerCapture(id){this.captured=id;},hasPointerCapture(id){return this.captured===id;},releasePointerCapture(){this.captured=null;},
    showModal(){this.open=true;},close(){this.open=false;},addEventListener(name,handler){this.listeners[name]=handler;}
  }]));
  nodes.get('#importModule').offsetHeight=150;nodes.get('#ticketModule').offsetHeight=420;nodes.get('#draftModule').offsetHeight=500;
  const toolLinks=[...html.matchAll(/<a class="tool" href="([^"]+)"[^>]*>([^<]+)/g)].map(match=>({
    textContent:match[2],attributes:{href:match[1]},classes:new Set(),getAttribute(name){return this.attributes[name];},setAttribute(name,value){this.attributes[name]=value;},
    classList:{toggle(name,value){if(value)this.owner.classes.add(name);else this.owner.classes.delete(name);}}
  }));
  for(const link of toolLinks)link.classList.owner=link;
  nodes.set('.layout',{});
  let savedDisk=disk,fail=diskFailure;
  const context={window:{addEventListener(){}},OpsWorkflow:workflow,AetherQueue:require('../public/queue'),AetherSession:format,AetherLayout:require('../public/desk-layout'),AbortController,console,setTimeout:()=>1,clearTimeout(){},setInterval(){},document:{querySelector(selector){assert(nodes.has(selector),'Unknown element '+selector);return nodes.get(selector);},querySelectorAll(selector){assert.equal(selector,'aside a.tool');return toolLinks;},addEventListener(){}},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},navigator:{clipboard:{writeText:async()=>{}}},fetch:async(url,options={})=>{
    assert.equal(url,'/api/session');
    if(fail)return {ok:false,status:500};
    if(options.method==='POST'){savedDisk=JSON.parse(options.body);return {ok:true,json:async()=>({savedAt:savedDisk.savedAt})};}
    return {ok:true,json:async()=>({session:savedDisk,recovered:false})};
  }};
  vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(project,'public/app.js'),'utf8'),context);
  return {context,nodes,storage,toolLinks,get disk(){return savedDisk;},fail(value){fail=value;},async ready(){for(let index=0;index<15;index++)await Promise.resolve();},async flush(){return vm.runInContext('flushSessionSave()',context);}};
}
test('existing tabs and drafts migrate to disk; active ticket and unfinished inputs restore',async()=>{
  const legacy=snapshot();
  const storage=new Map([['lastTicket',JSON.stringify(legacy.currentTicket)],['opsDeckDrafts',JSON.stringify(legacy.drafts)],['aetherDeskTicketTabs',JSON.stringify(legacy.tabs)],['opsDeck',JSON.stringify({tools:legacy.tools})]]);
  const page=browser({storage});await page.ready();
  assert.equal(page.disk.tabs[0].label,'AMS follow-up');
  assert.equal(page.disk.drafts['ITSM-101'].work,'Internal findings');
  page.nodes.get('#raw').value='Unfinished ticket paste';page.nodes.get('#raw').listeners.input();
  page.nodes.get('#tabLabel').value='Unfinished label';page.nodes.get('#tabLabel').listeners.input();
  page.nodes.get('#notes').value='Latest internal note';page.nodes.get('#notes').oninput();await page.flush();
  assert.equal(page.disk.inputs.raw,'Unfinished ticket paste');
  const restart=browser({disk:page.disk});await restart.ready();
  assert.equal(restart.nodes.get('#tabLabel').value,'Unfinished label');
  assert.equal(restart.nodes.get('#raw').value,'Unfinished ticket paste');
  assert.equal(restart.nodes.get('#notes').value,'Latest internal note');
  assert.equal(restart.nodes.get('#notes').hidden,false);
  assert.equal(restart.nodes.get('#tabCount').textContent,'1');
});
test('newer immediate browser save wins over an older disk copy',async()=>{
  const newer=snapshot({savedAt:'2026-10-27T03:00:00.000Z',inputs:{jiraInput:'ITSM-202',raw:'Newer unfinished work',tabLabel:'Newer label'}});
  const page=browser({storage:new Map([['aetherDeskSession',JSON.stringify(newer)]]),disk:snapshot()});await page.ready();
  assert.equal(page.nodes.get('#raw').value,'Newer unfinished work');
  assert.equal(page.disk.inputs.raw,'Newer unfinished work');
});
test('disk failure preserves browser session and clearly reports incomplete protection',async()=>{
  const page=browser({disk:snapshot()});await page.ready();page.fail(true);
  page.nodes.get('#notes').value='Keep this note';page.nodes.get('#notes').oninput();
  assert.equal(await page.flush(),false);
  assert(page.nodes.get('#sessionStatus').textContent.includes('browser only'));
  assert.equal(JSON.parse(page.storage.get('aetherDeskSession')).drafts['ITSM-101'].work,'Keep this note');
  page.fail(false);assert.equal(await page.flush(),true);assert.equal(page.disk.drafts['ITSM-101'].work,'Keep this note');
});
test('portable restore validates backup, requires review, and preserves pre-restore state',async()=>{
  const page=browser({disk:snapshot()});await page.ready();
  const backup=snapshot({tabs:[{label:'Restored tab',ticket:{key:'ITSM-202',title:'Other ticket'}}],currentTicket:{key:'ITSM-202',title:'Other ticket'}});
  page.nodes.get('#sessionFile').files=[{size:1000,text:async()=>JSON.stringify(backup)}];
  await page.nodes.get('#sessionFile').onchange();
  assert.equal(page.nodes.get('#restoreSessionDialog').open,true);
  assert.equal(page.nodes.get('#tabCount').textContent,'1');
  assert(!page.nodes.get('#ticket').innerHTML.includes('Other ticket'));
  await page.nodes.get('#confirmRestore').onclick();
  assert(page.nodes.get('#ticket').innerHTML.includes('Other ticket'));
  assert.equal(JSON.parse(page.storage.get('aetherDeskSessionBeforeRestore')).currentTicket.key,'ITSM-101');
  assert.equal(page.disk.tabs[0].label,'Restored tab');
});

test('local HTTP save restores after server restart and rejects foreign origins',async t=>{
  const {spawn}=require('node:child_process');
  const net=require('node:net');
  const directory=temporary(t);
  const slot=net.createServer();
  await new Promise(resolve=>slot.listen(0,'127.0.0.1',resolve));
  const port=slot.address().port;
  await new Promise(resolve=>slot.close(resolve));
  let child;
  async function start(){
    const script="const m=require(process.argv[1]);const original=m.createSessionStore;m.createSessionStore=()=>original(process.argv[2]);require(process.argv[3]);";
    child=spawn(process.execPath,['-e',script,path.join(project,'session-store.js'),directory,path.join(project,'server.js')],{cwd:project,env:{...process.env,PORT:String(port)},stdio:'ignore',windowsHide:true});
    let ready=false;
    for(let attempt=0;attempt<60;attempt++){
      try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert(ready,'Test server did not start');
  }
  async function stop(){
    if(!child||child.exitCode!==null)return;
    const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped;
  }
  try{
    await start();
    const url=`http://127.0.0.1:${port}/api/session`;
    assert.equal((await(await fetch(url)).json()).session,null);
    const saved=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Origin:`http://127.0.0.1:${port}`},body:JSON.stringify(snapshot())});
    assert.equal(saved.status,200);
    const blocked=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.com'},body:JSON.stringify(snapshot())});
    assert.equal(blocked.status,403);
    const invalid=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"version":99}'});
    assert.equal(invalid.status,400);
    await stop();await start();
    const loaded=await fetch(url);
    assert.equal(loaded.headers.get('cache-control'),'no-store');
    assert.equal((await loaded.json()).session.tabs[0].label,'AMS follow-up');
    assert.equal((await fetch(`http://127.0.0.1:${port}/.data/session.json`)).status,404);
  }finally{await stop();}
});


test('module dragging, overlap recovery and reset persist through session restore',async()=>{
  const page=browser({disk:snapshot()});await page.ready();
  const handle=page.nodes.get('#importHandle');
  const event=(extra={})=>({button:0,isPrimary:true,pointerId:7,clientX:10,clientY:10,preventDefault(){},stopPropagation(){},...extra});
  handle.listeners.pointerdown(event());
  handle.listeners.pointermove(event({clientX:140,clientY:250}));
  handle.listeners.pointerup(event());
  await page.flush();
  assert.equal(page.disk.layout.import.x,130);
  assert.equal(page.disk.layout.import.y,240);
  assert.equal(page.disk.layout.import.z,3);
  page.nodes.get('#showTicketModule').onclick();
  await page.flush();
  assert.equal(page.disk.layout.ticket.z,3);
  assert.equal(page.nodes.get('#ticketHandle').revealed,true);
  assert.equal(page.nodes.get('#ticketHandle').focused,true);
  const restarted=browser({disk:page.disk});await restarted.ready();
  assert.equal(restarted.nodes.get('#importModule').style.left,'130px');
  assert.equal(restarted.nodes.get('#importModule').style.top,'240px');
  assert.equal(restarted.nodes.get('#ticketModule').style.zIndex,'3');
  restarted.nodes.get('#resetDeskLayout').onclick();await restarted.flush();
  assert.equal(restarted.disk.layout.import.x,0);
  assert.equal(restarted.disk.layout.import.y,0);
  assert.equal(restarted.disk.layout.ticket.x,0);
});
test('module handles stay inside the desk; keyboard movement and pointer cancellation save position',async()=>{
  const page=browser({disk:snapshot()});await page.ready();
  const handle=page.nodes.get('#importHandle');
  const event=extra=>({button:0,isPrimary:true,pointerId:4,clientX:0,clientY:0,preventDefault(){},stopPropagation(){},...extra});
  handle.listeners.pointerdown(event({}));
  handle.listeners.pointermove(event({clientX:5000,clientY:-500}));
  handle.listeners.pointercancel(event({}));await page.flush();
  assert.equal(page.disk.layout.import.x,510);
  assert.equal(page.disk.layout.import.y,0);
  handle.listeners.keydown(event({key:'ArrowDown',shiftKey:true}));await page.flush();
  assert.equal(page.disk.layout.import.y,1);
  page.nodes.get('#deskCanvas').clientWidth=300;
  vm.runInContext('layoutManager.reflow()',page.context);
  assert.equal(page.nodes.get('#importModule').style.left,'0px');
  assert.equal(page.nodes.get('#importModule').style.width,'300px');
});
test('sidebar suggestions follow the active ticket and clear for a new ticket',async()=>{
  const page=browser({disk:snapshot()});await page.ready();
  const link=name=>page.toolLinks.find(link=>link.textContent===name);
  page.nodes.get('#raw').value='ITSM-202\nSummary: VLAN packet loss\nDescription: Network investigation';
  page.nodes.get('#parseBtn').onclick();
  assert(link('NetBox').classes.has('suggested'));
  assert(link('NetBox').attributes.title.includes('Network terms'));
  assert(!link('QA').classes.has('suggested'));
  page.nodes.get('#raw').value='ITSM-303\nSummary: Validation\nDescription: Testing completed';
  page.nodes.get('#parseBtn').onclick();
  assert(link('QA').classes.has('suggested'));
  assert(!link('NetBox').classes.has('suggested'));
  page.nodes.get('#newTicket').onclick();
  assert(page.toolLinks.every(link=>!link.classes.has('suggested')));
});
test('layout validation supports older backups and rejects unsafe coordinates',()=>{
  assert.deepEqual(format.validate(snapshot()).layout,{});
  const value=format.validate(snapshot({layout:{import:{x:-10,y:20000,z:100},ticket:{x:Infinity,y:0,z:1},unknown:{x:0,y:0,z:1}}}));
  assert.deepEqual(value.layout,{import:{x:0,y:10000,z:4,minimized:false}});
});

test('reporter greeting wraps a customer draft and never copies internal notes',async()=>{
  const page=browser({disk:snapshot({currentTicket:{key:'ITSM-101',title:'Example',reporter:'Taylor Example',commentMode:'service'}})});await page.ready();
  page.nodes.get('#customerMode').onclick();
  page.nodes.get('#customerReply').value='We have replaced the failed disk.';page.nodes.get('#customerReply').oninput();
  const internal=page.nodes.get('#notes').value;
  page.nodes.get('#addGreeting').onclick();
  assert.equal(page.nodes.get('#customerReply').value,'Hello Taylor Example,\n\nWe have replaced the failed disk.\n\nThank you.');
  const once=page.nodes.get('#customerReply').value;page.nodes.get('#addGreeting').onclick();assert.equal(page.nodes.get('#customerReply').value,once);
  assert.equal(page.nodes.get('#notes').value,internal);
});
test('posting reviews exact ticket and audience, preserves draft, and remembers receipt across restart',async()=>{
  const page=browser({disk:snapshot({currentTicket:{key:'ITSM-101',title:'Example',reporter:'Taylor',commentMode:'service'}})});await page.ready();
  const originalFetch=page.context.fetch;let posted;
  page.context.fetch=async(url,options)=>{
    if(url.endsWith('/comments')){posted=JSON.parse(options.body);return {ok:true,json:async()=>({id:'c100',created:'2026-10-27T11:00:00Z'})};}
    return originalFetch(url,options);
  };
  page.nodes.get('#customerMode').onclick();page.nodes.get('#customerReply').value='Reviewed public update';page.nodes.get('#customerReply').oninput();
  page.nodes.get('#postDraft').onclick();assert.equal(page.nodes.get('#jiraPostPreview').textContent,'Reviewed public update');assert(page.nodes.get('#jiraPostTitle').textContent.includes('ITSM-101'));assert(page.nodes.get('#jiraPostAudience').textContent.includes('PUBLIC'));
  await page.nodes.get('#confirmJiraPost').onclick();await page.flush();
  assert.deepEqual(posted,{visibility:'customer',body:'Reviewed public update'});assert.equal(page.nodes.get('#customerReply').value,'Reviewed public update');assert.equal(page.nodes.get('#postDraft').disabled,true);
  const restarted=browser({disk:page.disk});await restarted.ready();assert.equal(restarted.nodes.get('#postDraft').disabled,true);
  restarted.nodes.get('#customerReply').value='New update';restarted.nodes.get('#customerReply').oninput();assert.equal(restarted.nodes.get('#postDraft').disabled,false);
  restarted.nodes.get('#workMode').onclick();restarted.nodes.get('#postDraft').onclick();assert(restarted.nodes.get('#jiraPostAudience').textContent.includes('INTERNAL'));
});
test('uncertain posting keeps the draft and blocks blind retries',async()=>{
  const page=browser({disk:snapshot({currentTicket:{key:'ITSM-101',title:'Example',commentMode:'service'}})});await page.ready();
  page.nodes.get('#workMode').onclick();const text=page.nodes.get('#notes').value;page.nodes.get('#postDraft').onclick();
  page.context.fetch=async()=>{throw Error('Connection lost');};
  await page.nodes.get('#confirmJiraPost').onclick();
  assert.equal(page.nodes.get('#notes').value,text);assert.equal(page.nodes.get('#confirmJiraPost').disabled,true);assert(page.nodes.get('#jiraPostError').textContent.includes('Check the Jira ticket'));
});
test('live refresh changes Jira facts without overwriting drafts or unfinished input',async()=>{
  const page=browser({disk:snapshot()});await page.ready();
  page.nodes.get('#jiraInput').value='ITSM-202';page.nodes.get('#raw').value='Unfinished next ticket';page.nodes.get('#tabLabel').value='Label in progress';
  const notes=page.nodes.get('#notes').value;
  page.context.fetch=async()=>({ok:true,json:async()=>({baseUrl:'https://jira.example.com',issue:{key:'ITSM-101',fields:{summary:'Latest summary',reporter:{displayName:'Taylor'},status:{name:'In progress'}}},coordinates:{location:{display:'AMS'}},commentMode:'service',syncedAt:'2026-10-27T11:10:00Z'})});
  await page.nodes.get('#refreshTicket').onclick();
  assert(page.nodes.get('#ticket').innerHTML.includes('Latest summary'));assert(page.nodes.get('#ticket').innerHTML.includes('AMS'));
  assert.equal(page.nodes.get('#jiraInput').value,'ITSM-202');assert.equal(page.nodes.get('#raw').value,'Unfinished next ticket');assert.equal(page.nodes.get('#tabLabel').value,'Label in progress');assert.equal(page.nodes.get('#notes').value,notes);
});
test('coordinate partial success keeps the missing internal audit note as a draft',async()=>{
  const page=browser({disk:snapshot({currentTicket:{key:'ITSM-101',title:'Example',commentMode:'service'}})});await page.ready();
  let change;
  page.context.fetch=async(url,options={})=>{
    if(url.endsWith('/coordinates')&&options.method==='POST'){
      change=JSON.parse(options.body);return {ok:true,json:async()=>({changed:true,notePosted:false,note:'Rack coordinate changed to "R02"',warning:'Coordinate saved; check Jira before posting the audit note again.'})};
    }
    if(url.endsWith('/coordinates'))return {ok:true,json:async()=>({commentMode:'service',supportsOptionalWorkNote:true,coordinates:{rack:{kind:'text',value:'R01',source:'Jira field: Rackname'}}})};
    return {ok:true,json:async()=>({baseUrl:'https://jira.example.com',issue:{key:'ITSM-101',fields:{summary:'Example'}},coordinates:{rack:{display:'R02'}},commentMode:'service',syncedAt:'2026-10-27T11:00:00Z'})};
  };
  await page.context.window.openCoordinate('rack');page.nodes.get('#coordinateAddNote').checked=true;page.nodes.get('#coordinateValue').value='R02';page.nodes.get('#coordinateValue').oninput();
  assert(page.nodes.get('#coordinatePreview').textContent.includes('Rack coordinate changed to "R02"'));
  await page.nodes.get('#confirmCoordinate').onclick();
  assert.deepEqual(change,{coordinate:'rack',value:'R02',expectedValue:'R01',addWorkNote:true});
  assert(page.nodes.get('#notes').value.includes('Internal findings'));assert(page.nodes.get('#notes').value.includes('Rack coordinate changed to "R02"'));
  assert(page.nodes.get('#coordinateActionStatus').textContent.includes('check Jira'));
});

test('modules minimize independently, remain draggable and restore with the session',async()=>{
  const page=browser({disk:snapshot()});await page.ready();
  const click={stopPropagation(){}};
  page.nodes.get('#minimizeImport').onclick(click);
  page.nodes.get('#minimizeDraft').onclick(click);
  await page.flush();
  assert.equal(page.disk.layout.import.minimized,true);
  assert.equal(page.disk.layout.draft.minimized,true);
  assert.equal(page.disk.layout.ticket.minimized,false);
  assert.equal(page.nodes.get('#minimizeImport').textContent,'+');
  const handle=page.nodes.get('#importHandle');
  const event=extra=>({button:0,isPrimary:true,pointerId:8,clientX:0,clientY:0,preventDefault(){},stopPropagation(){},...extra});
  handle.listeners.pointerdown(event({}));handle.listeners.pointermove(event({clientX:50,clientY:45}));handle.listeners.pointerup(event({}));await page.flush();
  assert.equal(page.disk.layout.import.minimized,true);assert.equal(page.disk.layout.import.x,50);
  const restarted=browser({disk:page.disk});await restarted.ready();
  assert.equal(restarted.nodes.get('#minimizeImport').textContent,'+');
  assert.equal(restarted.nodes.get('#minimizeDraft').textContent,'+');
  restarted.nodes.get('#showImportModule').onclick();await restarted.flush();
  assert.equal(restarted.disk.layout.import.minimized,false);
  assert.equal(restarted.disk.layout.draft.minimized,true);
  restarted.nodes.get('#resetDeskLayout').onclick();await restarted.flush();
  assert(Object.values(restarted.disk.layout).every(position=>position.minimized===false));
});
test('comments display author/date and visibility, escape text, filter and retain cache on errors',async()=>{
  const page=browser({disk:snapshot({currentTicket:{key:'ITSM-101',title:'Example',commentMode:'service'}})});await page.ready();
  const originalFetch=page.context.fetch;
  let fail=false;
  page.context.fetch=async(url,options)=>{
    if(url.includes('/comments?')){
      if(fail)throw Error('Offline');
      return {ok:true,json:async()=>({comments:[{id:'1',body:'Customer update',author:'Taylor',visibility:'customer',created:'2026-10-28T09:00:00Z'},{id:'2',body:'<script>internal</script>',author:'Operator',visibility:'work',created:'2026-10-28T10:00:00Z'}],nextStart:null,complete:true})};
    }
    return originalFetch(url,options);
  };
  await page.nodes.get('#refreshComments').onclick();
  const all=page.nodes.get('#commentsList').innerHTML;
  assert(all.includes('Customer reply'));assert(all.includes('Internal note'));assert(all.includes('Taylor'));assert(all.includes('Operator'));assert(all.includes('&lt;script&gt;'));assert(!all.includes('<script>'));
  assert(all.indexOf('Operator')<all.indexOf('Taylor'));
  page.nodes.get('#commentFilter').value='work';page.nodes.get('#commentFilter').onchange();
  assert(!page.nodes.get('#commentsList').innerHTML.includes('Customer update'));
  assert(page.nodes.get('#commentsList').innerHTML.includes('internal'));
  await page.flush();assert.equal(page.disk.inputs.commentFilter,'work');
  fail=true;await page.nodes.get('#refreshComments').onclick();
  assert(page.nodes.get('#commentsList').innerHTML.includes('internal'));
  assert(page.nodes.get('#commentsStatus').textContent.includes('previously loaded'));
});
test('comments from a previous ticket do not appear when a delayed request completes',async()=>{
  const page=browser({disk:snapshot({currentTicket:{key:'ITSM-101',title:'Example',commentMode:'service'}})});await page.ready();
  let finish;
  page.context.fetch=()=>new Promise(resolve=>{finish=resolve;});
  const request=page.nodes.get('#refreshComments').onclick();
  page.nodes.get('#raw').value='ITSM-202\nSummary: Other ticket';page.nodes.get('#parseBtn').onclick();
  finish({ok:true,json:async()=>({comments:[{id:'old',body:'Old private comment',author:'Operator',visibility:'work',created:'2026-10-28T10:00:00Z'}],nextStart:null,complete:true})});
  await request;
  assert(!page.nodes.get('#commentsList').innerHTML.includes('Old private comment'));
  assert.equal(page.nodes.get('#refreshComments').disabled,true);
});


test('an old server missing the comments route gives a useful restart message',async()=>{
  const page=browser({disk:snapshot({currentTicket:{key:'ITSM-101',title:'Example',commentMode:'service'}})});await page.ready();
  page.context.fetch=async()=>({ok:false,status:404,json:async()=>{throw Error('HTML response');}});
  await page.nodes.get('#refreshComments').onclick();
  assert(page.nodes.get('#commentsStatus').textContent.includes('server needs restarting'));
});
test('nested Jira request types display a readable name instead of an object',async()=>{
  const page=browser({disk:snapshot()});await page.ready();
  const result=vm.runInContext("normalise({baseUrl:'https://example.com',issue:{key:'ITSM-101',names:{customfield_1:'Customer Request Type'},fields:{summary:'Example',issuetype:{name:'Incident'},customfield_1:{requestType:{name:'Remote hands'}}}}})",page.context);
  assert.equal(result.requestType,'Remote hands');
  assert.equal(vm.runInContext("value({unknown:'unmapped'})",page.context),'');
});

test('status change reviews current workflow, blocks required fields, updates ticket and keeps drafts',async()=>{
  const page=browser({disk:snapshot()});await page.ready();const originalFetch=page.context.fetch;let submitted;
  page.context.fetch=async(url,options={})=>{
    if(url.endsWith('/transitions')&&options.method==='POST'){submitted=JSON.parse(options.body);return {ok:true,json:async()=>({status:'Resolved',changed:true})};}
    if(url.endsWith('/transitions'))return {ok:true,json:async()=>({status:'In Progress',transitions:[{id:'21',name:'Resolve',status:'Resolved',requiredFields:[]},{id:'31',name:'Close',status:'Closed',requiredFields:[{name:'Resolution'}]}]})};
    if(url.includes('/comments?'))return {ok:true,json:async()=>({comments:[],complete:true,nextStart:null})};
    if(url==='/api/ticket/ITSM-101')return {ok:true,json:async()=>({baseUrl:'https://jira.example.com',issue:{key:'ITSM-101',fields:{summary:'Example',status:{name:'Resolved'}}},commentMode:'service',syncedAt:'2026-10-28T12:00:00Z'})};
    return originalFetch(url,options);
  };
  const notes=page.nodes.get('#notes').value;
  await page.nodes.get('#changeTicketStatus').onclick();assert(page.nodes.get('#currentStatusText').textContent.includes('In Progress'));
  page.nodes.get('#statusTransition').value='31';page.nodes.get('#statusTransition').onchange();assert.equal(page.nodes.get('#confirmStatusChange').disabled,true);assert(page.nodes.get('#statusTransitionHint').textContent.includes('Resolution'));
  page.nodes.get('#statusTransition').value='21';page.nodes.get('#statusTransition').onchange();assert.equal(page.nodes.get('#confirmStatusChange').disabled,false);
  await page.nodes.get('#confirmStatusChange').onclick();
  assert.deepEqual(submitted,{transitionId:'21',expectedStatus:'In Progress'});assert(page.nodes.get('#ticket').innerHTML.includes('Resolved'));assert.equal(page.nodes.get('#notes').value,notes);assert.equal(page.nodes.get('#statusDialog').open,false);
});

test('compact ticket form shows loading once, then success feedback on a confirmed open',async()=>{
  const page=browser({disk:snapshot()});await page.ready();
  const classes=new Set();page.nodes.get('#importModule').classList={add:name=>classes.add(name),remove:name=>classes.delete(name),toggle:(name,value)=>value?classes.add(name):classes.delete(name)};
  const arrivals=new Set();page.nodes.get('#ticketModule').classList={add:name=>arrivals.add(name),remove:name=>arrivals.delete(name),toggle:(name,value)=>value?arrivals.add(name):arrivals.delete(name)};
  let finish,reads=0;
  page.context.fetch=()=>{reads++;return new Promise(resolve=>{finish=resolve;});};
  page.nodes.get('#jiraInput').value='https://jira.example.com/browse/ITSM-202';
  const submit=page.nodes.get('#openTicketForm').onsubmit({preventDefault(){}});
  assert.equal(page.nodes.get('#importBtn').textContent,'Opening');assert.equal(page.nodes.get('#importBtn').disabled,true);assert(classes.has('is-opening'));
  await page.nodes.get('#openTicketForm').onsubmit({preventDefault(){}});assert.equal(reads,1);
  finish({ok:true,json:async()=>({baseUrl:'https://jira.example.com',issue:{key:'ITSM-202',fields:{summary:'Opened ticket'}},commentMode:'unsupported'})});
  await submit;
  assert.equal(page.nodes.get('#importBtn').textContent,'Opened');assert.equal(page.nodes.get('#importBtn').disabled,false);assert(classes.has('is-opened'));assert(!classes.has('is-opening'));
  assert(arrivals.has('ticket-arrived'));assert.equal(page.nodes.get('#ticketInputAnnouncement').textContent,'ITSM-202 opened');assert.equal(page.nodes.get('#pasteTicketDetails').open,false);
});
test('failed opening shows an inline error without success feedback or lost drafts',async()=>{
  const page=browser({disk:snapshot()});await page.ready();
  const draft=page.nodes.get('#notes').value;
  page.context.fetch=async()=>({ok:false,status:503,json:async()=>({error:'Jira is unavailable.'})});
  page.nodes.get('#jiraInput').value='ITSM-202';
  await page.nodes.get('#openTicketForm').onsubmit({preventDefault(){}});
  assert.equal(page.nodes.get('#importBtn').textContent,'Open');assert.equal(page.nodes.get('#importBtn').disabled,false);
  assert.equal(page.nodes.get('#ticketInputFeedback').hidden,false);assert.equal(page.nodes.get('#ticketInputFeedback').textContent,'Jira is unavailable.');
  assert.equal(page.nodes.get('#ticketInputAnnouncement').textContent,'');assert.equal(page.nodes.get('#notes').value,draft);
});
test('background refresh and superseded ticket requests do not announce a new ticket opening',async()=>{
  const page=browser({disk:snapshot()});await page.ready();
  const payload={baseUrl:'https://jira.example.com',issue:{key:'ITSM-101',fields:{summary:'Latest ticket'}},commentMode:'unsupported'};
  page.context.fetch=async()=>({ok:true,json:async()=>payload});await page.nodes.get('#refreshTicket').onclick();
  assert.equal(page.nodes.get('#ticketInputAnnouncement').textContent,'');
  let finish;page.context.fetch=()=>new Promise(resolve=>{finish=resolve;});page.nodes.get('#jiraInput').value='ITSM-202';
  const pending=page.nodes.get('#openTicketForm').onsubmit({preventDefault(){}});page.nodes.get('#newTicket').onclick();
  finish({ok:true,json:async()=>({...payload,issue:{key:'ITSM-202',fields:{summary:'Late response'}}})});await pending;
  assert.equal(page.nodes.get('#importBtn').textContent,'Open');assert.equal(page.nodes.get('#ticketInputAnnouncement').textContent,'');assert(!page.nodes.get('#ticket').innerHTML.includes('Late response'));
});

test('ticket overview folds secondary fields and keeps more details open on same-ticket refresh',async()=>{
  const page=browser({disk:snapshot({currentTicket:{key:'ITSM-101',title:'Main ticket',description:'Visible problem',status:'In Progress',priority:'Urgent',reporter:'Hidden reporter',assignee:'Hidden assignee',location:'AMS',rack:'R12',commentMode:'service'}})});await page.ready();
  const first=page.nodes.get('#ticket').innerHTML;
  const overview=first.split('<details class="ticket-more-details"')[0];
  assert(overview.includes('Visible problem'));assert(overview.includes('AMS'));assert(overview.includes('R12'));
  assert(!overview.includes('Hidden reporter'));assert(!overview.includes('Hidden assignee'));assert(!overview.includes('Urgent'));
  assert(first.includes('More details'));assert(first.includes('More actions'));assert(first.includes('data-coordinate="location"'));
  page.nodes.get('#ticket').querySelector=selector=>selector==='.ticket-more-details'?{open:true}:null;
  page.context.fetch=async()=>({ok:true,json:async()=>({baseUrl:'https://jira.example.com',issue:{key:'ITSM-101',fields:{summary:'Updated title',status:{name:'In Progress'}}},commentMode:'unsupported'})});
  await page.nodes.get('#refreshTicket').onclick();
  assert(page.nodes.get('#ticket').innerHTML.includes('<details class="ticket-more-details" open>'));
  page.nodes.get('#raw').value='ITSM-202\nSummary: Another ticket';page.nodes.get('#parseBtn').onclick();
  assert(!page.nodes.get('#ticket').innerHTML.includes('<details class="ticket-more-details" open>'));
});
test('single coordinate editor switches fields without opening a second dialog',async()=>{
  const page=browser({disk:snapshot({currentTicket:{key:'ITSM-101',title:'Example',commentMode:'service'}})});await page.ready();
  page.context.fetch=async()=>({ok:true,json:async()=>({commentMode:'service',supportsOptionalWorkNote:true,coordinates:{location:{kind:'note',value:'AMS',source:'Ticket coordinate'},rack:{kind:'text',value:'R12',source:'Jira field: Rackname'}}})});
  await page.context.window.openCoordinate('location');
  assert.equal(page.nodes.get('#coordinateTarget').value,'location');assert.equal(page.nodes.get('#coordinateValue').value,'AMS');
  page.nodes.get('#coordinateTarget').value='rack';await page.nodes.get('#coordinateTarget').onchange();
  assert.equal(page.nodes.get('#coordinateDialog').open,true);assert.equal(page.nodes.get('#coordinateValue').value,'R12');assert(page.nodes.get('#coordinateTitle').textContent.includes('Rack'));
});
test('clicking the overview status badge reaches the existing Jira transition dialog',async()=>{
  const page=browser({disk:snapshot()});await page.ready();
  page.context.fetch=async()=>({ok:true,json:async()=>({status:'In Progress',transitions:[{id:'21',name:'Resolve',status:'Resolved',requiredFields:[]}]})});
  await page.context.window.openTicketStatus();
  assert.equal(page.nodes.get('#statusDialog').open,true);assert(page.nodes.get('#currentStatusText').textContent.includes('In Progress'));
});


test('coordinate squares show every paste field and the advanced Jira editor remains accessible',async()=>{
  const page=browser({disk:snapshot({currentTicket:{key:'ITSM-101',title:'Example',location:'AMS',serviceTag:'<asset>',commentMode:'service'}})});await page.ready();
  const html=page.nodes.get('#ticket').innerHTML;
  assert.equal((html.match(/class="coordinate-tile coordinate-paste-tile"/g)||[]).length,4);
  for(const key of ['location','rack','unit','serviceTag'])assert(html.includes(`data-coordinate="${key}"`));
  assert(html.includes('placeholder="Paste here"'));assert(html.includes('&lt;asset&gt;'));assert(!html.includes('<asset>'));
  page.context.fetch=async()=>({ok:true,json:async()=>({commentMode:'service',supportsOptionalWorkNote:true,coordinates:{unit:{kind:'note',value:'U12',source:'Ticket coordinate'}}})});
  await page.context.window.openCoordinate('unit');
  assert.equal(page.nodes.get('#coordinateTarget').value,'unit');assert.equal(page.nodes.get('#coordinateValue').value,'U12');assert.equal(page.nodes.get('#coordinateDialog').open,true);
});

test('coordinate work-note toggle starts off, updates preview, and resets for a new edit',async()=>{
  const page=browser({disk:snapshot({currentTicket:{key:'ITSM-101',title:'Example',commentMode:'service'}})});await page.ready();
  page.context.fetch=async()=>({ok:true,json:async()=>({commentMode:'service',supportsOptionalWorkNote:true,coordinates:{rack:{kind:'text',value:'R01',source:'Jira field: Rackname'},unit:{kind:'note',value:'U10',source:'Ticket coordinate'}}})});
  await page.context.window.openCoordinate('rack');
  assert.equal(page.nodes.get('#coordinateAddNote').checked,false);assert.equal(page.nodes.get('#coordinatePreview').hidden,true);assert.equal(page.nodes.get('#confirmCoordinate').textContent,'Save coordinate');
  page.nodes.get('#coordinateAddNote').checked=true;page.nodes.get('#coordinateAddNote').onchange();
  assert.equal(page.nodes.get('#coordinatePreview').hidden,false);assert(page.nodes.get('#coordinatePreview').textContent.includes('Rack coordinate changed'));assert.equal(page.nodes.get('#confirmCoordinate').textContent,'Save coordinate + work note');
  page.nodes.get('#coordinateTarget').value='unit';await page.nodes.get('#coordinateTarget').onchange();assert.equal(page.nodes.get('#coordinateAddNote').checked,true);
  page.nodes.get('#cancelCoordinate').onclick();await page.context.window.openCoordinate('rack');assert.equal(page.nodes.get('#coordinateAddNote').checked,false);
});
test('coordinate save with toggle off does not alter the internal work-note draft',async()=>{
  const page=browser({disk:snapshot({currentTicket:{key:'ITSM-101',title:'Example',commentMode:'service'}})});await page.ready();
  const notes=page.nodes.get('#notes').value;let sent;
  page.context.fetch=async(url,options={})=>{
    if(url.endsWith('/coordinates')&&options.method==='POST'){sent=JSON.parse(options.body);return {ok:true,json:async()=>({changed:true,notePosted:false,noteRequested:false})};}
    if(url.endsWith('/coordinates'))return {ok:true,json:async()=>({commentMode:'service',supportsOptionalWorkNote:true,coordinates:{rack:{kind:'text',value:'R01',source:'Jira field: Rackname'}}})};
    if(url.includes('/comments?'))return {ok:true,json:async()=>({comments:[],complete:true,nextStart:null})};
    return {ok:true,json:async()=>({baseUrl:'https://jira.example.com',issue:{key:'ITSM-101',fields:{summary:'Example'}},commentMode:'service',coordinates:{rack:{display:'R02'}}})};
  };
  await page.context.window.openCoordinate('rack');page.nodes.get('#coordinateValue').value='R02';await page.nodes.get('#confirmCoordinate').onclick();
  assert.equal(sent.addWorkNote,false);assert.equal(page.nodes.get('#notes').value,notes);assert(page.nodes.get('#coordinateActionStatus').textContent.includes('No work note added'));
});
test('an old server cannot ignore the no-work-note choice silently',async()=>{
  const page=browser({disk:snapshot({currentTicket:{key:'ITSM-101',title:'Example',commentMode:'service'}})});await page.ready();
  page.context.fetch=async()=>({ok:true,json:async()=>({commentMode:'service',coordinates:{rack:{kind:'text',value:'R01'}}})});
  await page.context.window.openCoordinate('rack');assert.equal(page.nodes.get('#confirmCoordinate').disabled,true);assert(page.nodes.get('#coordinateError').textContent.includes('Restart Aether Desk'));
});

test('copy/paste coordinates save locally per ticket and survive session restore without Jira writes',async()=>{
  const page=browser({disk:snapshot()});await page.ready();const originalFetch=page.context.fetch;let jiraRequests=0;
  page.context.fetch=(url,options)=>{if(url.startsWith('/api/ticket/'))jiraRequests++;return originalFetch(url,options);};
  const values={location:'AMS-01',rack:'R12',unit:'U04',serviceTag:'SV-100'};
  for(const [coordinate,value]of Object.entries(values))page.nodes.get('#ticket').listeners.input({target:{dataset:{coordinate},value}});
  await page.flush();assert.deepEqual(page.disk.drafts['ITSM-101'].coordinates,values);assert.equal(jiraRequests,0);
  const restarted=browser({disk:page.disk});await restarted.ready();
  for(const value of Object.values(values))assert(restarted.nodes.get('#ticket').innerHTML.includes(value));
  restarted.nodes.get('#raw').value='ITSM-202\nSummary: Second ticket';restarted.nodes.get('#parseBtn').onclick();
  restarted.nodes.get('#ticket').listeners.input({target:{dataset:{coordinate:'location'},value:'Second site'}});
  restarted.context.window.openTicketTab(0);assert(restarted.nodes.get('#ticket').innerHTML.includes('AMS-01'));assert(!restarted.nodes.get('#ticket').innerHTML.includes('Second site'));
});
test('coordinate note button posts exactly all four values internally and does not change drafts or fields',async()=>{
  const page=browser({disk:snapshot({currentTicket:{key:'ITSM-101',title:'Example',commentMode:'service'}})});await page.ready();const originalFetch=page.context.fetch;const posts=[];
  page.context.fetch=async(url,options={})=>{
    if(url.endsWith('/comments')&&options.method==='POST'){posts.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({id:'coordinates-1',created:'2026-10-28T12:00:00Z'})};}
    if(url.includes('/comments?'))return {ok:true,json:async()=>({comments:[],nextStart:null,complete:true})};
    return originalFetch(url,options);
  };
  const before=page.nodes.get('#notes').value;
  for(const [coordinate,value]of Object.entries({location:'AMS',rack:'R12',unit:'U04',serviceTag:'SV-100'}))page.nodes.get('#ticket').listeners.input({target:{dataset:{coordinate},value}});
  assert.equal(posts.length,0);
  await page.context.window.postCoordinateSnapshot();await page.flush();
  assert.deepEqual(posts,[{url:'/api/ticket/ITSM-101/comments',body:{visibility:'work',body:'Work coordinates\nDatacenter: AMS\nRack: R12\nUnit: U04\nService tag: SV-100'}}]);
  assert.equal(page.nodes.get('#notes').value,before);assert.equal(page.disk.drafts['ITSM-101'].coordinatePost.id,'coordinates-1');
  await page.context.window.postCoordinateSnapshot();assert.equal(posts.length,1);
});
test('ticket edit panels expand inline and are dismissed when changing tickets',async()=>{
  const page=browser({disk:snapshot({currentTicket:{key:'ITSM-101',title:'Example',commentMode:'service'}})});await page.ready();
  const html=fs.readFileSync(path.join(project,'public/index.html'),'utf8');assert(!html.includes('Ticket workspace'));assert(!html.includes("Hold a module's title bar"));
  for(const id of ['coordinateDialog','statusDialog','jiraPostDialog']){assert(!html.includes('<dialog id="'+id+'"'));page.nodes.get('#'+id).showModal=()=>{throw Error('A modal must not open');};}
  page.context.fetch=async url=>({ok:true,json:async()=>url.endsWith('/transitions')?{status:'In Progress',transitions:[]}:{supportsOptionalWorkNote:true,commentMode:'service',coordinates:{rack:{kind:'text',value:'R12',source:'Jira field: Rackname'}}}});
  await page.context.window.openTicketStatus();assert.equal(page.nodes.get('#statusDialog').hidden,false);
  await page.context.window.openCoordinate('rack');assert.equal(page.nodes.get('#coordinateDialog').hidden,false);
  page.nodes.get('#customerMode').onclick();page.nodes.get('#customerReply').value='Public update';page.nodes.get('#postDraft').onclick();assert.equal(page.nodes.get('#jiraPostDialog').hidden,false);
  page.nodes.get('#raw').value='ITSM-202\nSummary: Different ticket';page.nodes.get('#parseBtn').onclick();
  for(const id of ['coordinateDialog','statusDialog','jiraPostDialog'])assert.equal(page.nodes.get('#'+id).hidden,true);
});
test('coordinate posting failure retains copied values and never retries automatically',async()=>{
  const page=browser({disk:snapshot({currentTicket:{key:'ITSM-101',title:'Example',commentMode:'service'}})});await page.ready();
  page.nodes.get('#ticket').listeners.input({target:{dataset:{coordinate:'rack'},value:'R99'}});
  let requests=0;page.context.fetch=async()=>{requests++;throw Error('Offline');};
  await page.context.window.postCoordinateSnapshot();
  const values=vm.runInContext('coordinateValues()',page.context);assert.equal(values.rack,'R99');assert.equal(requests,1);
  assert.equal(vm.runInContext("drafts['ITSM-101'].coordinatePost",page.context),undefined);
});

test('conversation shows three recent previews, expands history, paginates and remembers opened messages',async()=>{
  const page=browser({disk:snapshot({currentTicket:{key:'ITSM-101',title:'Example',commentMode:'service'}})});await page.ready();
  const originalFetch=page.context.fetch;
  const comments=Array.from({length:6},(_,index)=>({id:String(index+1),author:'Author '+index,body:'Message '+index+' '+ 'long text '.repeat(30),visibility:index%2?'work':'customer',created:'2026-10-28T0'+index+':00:00Z'}));
  const starts=[];
  page.context.fetch=async(url,options)=>{
    if(!url.includes('/comments?'))return originalFetch(url,options);
    starts.push(url);
    return {ok:true,json:async()=>url.endsWith('start=10')?{comments:[{id:'older',author:'Earlier author',body:'Older message',visibility:'customer',created:'2026-10-27T01:00:00Z'}],nextStart:null,complete:true}:{comments,nextStart:10,complete:false}};
  };
  await page.nodes.get('#refreshComments').onclick();
  const list=page.nodes.get('#commentsList');
  assert.equal((list.innerHTML.match(/<details /g)||[]).length,3);
  assert(list.innerHTML.indexOf('Author 5')<list.innerHTML.indexOf('Author 4'));
  assert(!list.innerHTML.includes('Author 0'));
  assert.equal(page.nodes.get('#moreComments').hidden,true);
  assert.equal(page.nodes.get('#toggleHistory').hidden,false);
  const detail={matches:()=>true,dataset:{ticketKey:'ITSM-101',commentId:'6'},open:true};
  list.listeners.toggle({target:detail});
  page.nodes.get('#toggleHistory').onclick();
  assert.equal((list.innerHTML.match(/<details /g)||[]).length,6);
  assert(list.innerHTML.includes('data-comment-id="6" open'));
  detail.open=false;list.listeners.toggle({target:detail});
  page.nodes.get('#commentFilter').onchange();
  assert(!list.innerHTML.includes('data-comment-id="6" open'));
  assert.equal(page.nodes.get('#moreComments').hidden,false);
  await page.nodes.get('#moreComments').onclick();
  assert(starts.at(-1).endsWith('start=10'));
  assert(list.innerHTML.includes('Older message'));
  assert.equal(page.nodes.get('#moreComments').hidden,true);
  page.nodes.get('#toggleHistory').onclick();
  assert.equal((list.innerHTML.match(/<details /g)||[]).length,3);
  assert(!page.nodes.has('#commentsModule'));
});

test('legacy separate module positions migrate to Conversation without losing drafts or minimized state',async()=>{
  const legacy={draft:{x:100,y:260,z:3,minimized:true},comments:{x:30,y:900,z:4,minimized:false}};
  const page=browser({disk:snapshot({layout:legacy})});await page.ready();await page.nodes.get('#saveSessionNow').onclick();
  assert.equal(page.disk.layout.draft.x,100);assert.equal(page.disk.layout.draft.y,260);
  assert.equal(page.disk.layout.draft.minimized,false);
  assert.equal(page.disk.layout.comments,undefined);
  assert.equal(page.disk.drafts['ITSM-101'].work,'Internal findings');
  assert.equal(page.disk.drafts['ITSM-101'].customer,'Customer update');
  page.nodes.get('#minimizeDraft').onclick({stopPropagation(){}});await page.flush();
  const restarted=browser({disk:page.disk});await restarted.ready();
  assert.equal(restarted.nodes.get('#minimizeDraft').textContent,'+');
  assert.equal(restarted.nodes.get('#notes').value,'Internal findings');
  const layout=require('../public/desk-layout');
  assert.equal(layout.normalize({comments:legacy.comments}).draft.x,30);
  assert.equal(layout.normalize({draft:legacy.draft,comments:{...legacy.comments,minimized:true}}).draft.minimized,true);
});

test('conversation composer keeps public and internal drafts separate with a single review action',async()=>{
  const page=browser({disk:snapshot()});await page.ready();
  assert.equal(page.nodes.get('#draftVisibility').textContent,'Internal');
  assert.equal(page.nodes.get('#addGreeting').hidden,true);
  assert.equal(page.nodes.get('#postDraft').textContent,'Review & send');
  page.nodes.get('#customerMode').onclick();
  assert.equal(page.nodes.get('#draftVisibility').textContent,'Public');
  assert.equal(page.nodes.get('#addGreeting').hidden,false);
  assert.equal(page.nodes.get('#customerReply').hidden,false);
  assert.equal(page.nodes.get('#notes').hidden,true);
  let copied;
  page.context.navigator.clipboard.writeText=async text=>{copied=text;};
  page.nodes.get('#composerMore').open=true;
  await page.nodes.get('#copyDraft').onclick();
  assert.equal(copied,'Customer update');
  assert.equal(page.nodes.get('#composerMore').open,false);
  page.nodes.get('#workMode').onclick();
  assert.equal(page.nodes.get('#notes').value,'Internal findings');
  assert.equal(page.nodes.get('#draftVisibility').textContent,'Internal');
});

test('opening a live queue ticket preserves the previous drafts and session tabs',async()=>{
  const page=browser({disk:snapshot()});await page.ready();
  const originalFetch=page.context.fetch;
  page.context.fetch=async(url,options)=>{
    if(url==='/api/ticket/queue')return {ok:true,json:async()=>({filterId:'20741',name:'Unassigned',issues:[{key:'ITSM-202',title:'Next task'}],nextPageToken:null,syncedAt:'2026-10-29T10:00:00Z'})};
    if(url==='/api/ticket/ITSM-202')return {ok:true,json:async()=>({baseUrl:'https://jira.example.com',issue:{key:'ITSM-202',fields:{summary:'Next task'}},commentMode:'service'})};
    if(url.includes('/comments?'))return {ok:true,json:async()=>({comments:[],nextStart:null,complete:true})};
    return originalFetch(url,options);
  };
  page.nodes.get('#notes').value='Unfinished previous ticket findings';
  await page.nodes.get('#showQueue').onclick();
  await page.nodes.get('#queueRows').listeners.click({target:{closest:()=>({dataset:{queueKey:'ITSM-202'}})}});
  await page.flush();
  assert.equal(page.disk.currentTicket.key,'ITSM-202');
  assert.equal(page.disk.drafts['ITSM-101'].work,'Unfinished previous ticket findings');
  assert.equal(page.disk.tabs[0].label,'AMS follow-up');
  assert.equal(page.nodes.get('#queuePanel').hidden,true);
});

test('attachments render escaped file names and local links and survive saved-session restore',async()=>{
  const ticket={key:'ITSM-101',title:'Example',attachments:[{id:'500',filename:'<script>photo</script>.png',mimeType:'image/png',size:2048,author:'Taylor',created:'2026-10-29T10:00:00Z',content:'https://untrusted.example/file'}]};
  const page=browser({disk:snapshot({currentTicket:ticket,tabs:[{label:'Attached ticket',ticket}]})});await page.ready();
  const html=page.nodes.get('#ticket').innerHTML;
  assert(html.includes('Attachments (1)'));assert(html.includes('&lt;script&gt;photo&lt;/script&gt;.png'));assert(!html.includes('<script>photo'));
  assert(html.includes('/api/ticket/ITSM-101/attachments/500?download=1'));assert(html.includes('2 KB'));assert(!html.includes('untrusted.example'));
  await page.nodes.get('#saveSessionNow').onclick();
  assert.equal(page.disk.currentTicket.attachments[0].id,'500');assert.equal(page.disk.currentTicket.attachments[0].content,undefined);
  assert.equal(page.disk.tabs[0].ticket.attachments[0].id,'500');
  const restarted=browser({disk:page.disk});await restarted.ready();
  assert(restarted.nodes.get('#ticket').innerHTML.includes('Attachments (1)'));
  const payload=vm.runInContext("normalise({baseUrl:'https://jira.example.com',issue:{key:'ITSM-202',fields:{attachment:[{id:'600',filename:'report.pdf',mimeType:'application/pdf',size:1048576,author:{displayName:'Reporter'}},{id:'bad',filename:'Skip'}]}}})",page.context);
  assert.equal(payload.attachments.length,1);assert.equal(payload.attachments[0].author,'Reporter');
});
test('older saved tickets offer attachment refresh while confirmed empty lists show no files',async()=>{
  const page=browser({disk:snapshot()});await page.ready();
  assert(page.nodes.get('#ticket').innerHTML.includes('Refresh from Jira to load attached files'));
  vm.runInContext("render({key:'ITSM-202',title:'Empty',attachments:[]})",page.context);
  assert(page.nodes.get('#ticket').innerHTML.includes('Attachments (0)'));
  assert(page.nodes.get('#ticket').innerHTML.includes('No attached files'));
});

test('ticket screenshot targets only current panel bounds and saves its PNG to the local server',async()=>{
  const page=browser({disk:snapshot()});await page.ready();
  const panel=page.nodes.get('#ticketModule');panel.getBoundingClientRect=()=>({width:640,height:520});
  const before=page.nodes.get('#notes').value;let target,options,blobType,sent;
  const blob={type:'image/png'};
  page.context.html2canvas=async(element,config)=>{target=element;options=config;return {toBlob(callback,type){blobType=type;callback(blob);}};};
  const originalFetch=page.context.fetch;
  page.context.fetch=async(url,config)=>{
    if(url.startsWith('/api/screenshots')){sent={url,config};return {ok:true,json:async()=>({path:'C:\\CODEX\\ops-deck-jira\\Screenshots\\ITSM-101-test.png'})};}
    return originalFetch(url,config);
  };
  await page.nodes.get('#captureTicket').onclick();
  assert.equal(target,panel);assert.equal(options.width,640);assert.equal(options.height,520);
  assert.equal(blobType,'image/png');assert.equal(sent.url,'/api/screenshots?key=ITSM-101');
  assert.equal(sent.config.method,'POST');assert.equal(sent.config.headers['Content-Type'],'image/png');assert.equal(sent.config.body,blob);
  assert.equal(page.nodes.get('#notes').value,before);assert(page.nodes.get('#state').textContent.includes('Screenshots\\ITSM-101-test.png'));
});
test('ticket screenshot blocks duplicate clicks and recovers after a failed render',async()=>{
  const page=browser({disk:snapshot()});await page.ready();
  page.nodes.get('#ticketModule').getBoundingClientRect=()=>({width:640,height:40});
  let reject,calls=0;
  page.context.html2canvas=()=>{calls++;return new Promise((resolve,fail)=>{reject=fail;});};
  const pending=page.nodes.get('#captureTicket').onclick();
  await page.nodes.get('#captureTicket').onclick();assert.equal(calls,1);
  reject(Error('Render unavailable'));await pending;
  assert(page.nodes.get('#state').textContent.includes('Screenshot failed'));
  const retry=page.nodes.get('#captureTicket').onclick();assert.equal(calls,2);reject(Error('Retry failure'));await retry;
  assert.equal(page.nodes.get('#notes').value,'Internal findings');
});

test('local screenshot saving writes unique PNGs only inside its folder and rejects invalid callers and payloads',async t=>{
  const directory=temporary(t),screenshots=path.join(directory,'Screenshots');
  const express=require('express'),app=express();
  app.use('/api/screenshots',require('../screenshot-routes').createScreenshotRouter({directory:screenshots}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port+'/api/screenshots';
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8t8AAAAASUVORK5CYII=','base64');
  const options={method:'POST',headers:{'Content-Type':'image/png'},body:png};
  const first=await fetch(base+'?key=ITSM-101',options);assert.equal(first.status,201);
  const file=await first.json();assert.equal(path.dirname(file.path),screenshots);assert(file.filename.startsWith('ITSM-101-'));
  assert.deepEqual(fs.readFileSync(file.path),png);
  const second=await fetch(base+'?key=ITSM-101',options);assert.equal(second.status,201);assert.notEqual((await second.json()).filename,file.filename);
  const invalid=await fetch(base+'?key=..%2Fescape',options);assert.equal(invalid.status,400);
  const nonPNG=await fetch(base,{...options,body:Buffer.from('not an image')});assert.equal(nonPNG.status,400);
  const blocked=await fetch(base,{...options,headers:{...options.headers,Origin:'https://unrelated.example'}});assert.equal(blocked.status,403);
  assert.equal(fs.readdirSync(screenshots).length,2);
});
test('screenshot disk failure reports failure rather than a saved file',async t=>{
  const directory=temporary(t),blocked=path.join(directory,'not-a-directory');fs.writeFileSync(blocked,'existing');
  const express=require('express'),app=express();
  app.use('/api/screenshots',require('../screenshot-routes').createScreenshotRouter({directory:blocked}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8t8AAAAASUVORK5CYII=','base64');
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/screenshots',{method:'POST',headers:{'Content-Type':'image/png'},body:png});
  assert.equal(response.status,500);assert((await response.json()).error.includes('Could not save'));
  assert.equal(fs.readFileSync(blocked,'utf8'),'existing');
});
test('failed screenshot save retains drafts and never reports success',async()=>{
  const page=browser({disk:snapshot()});await page.ready();
  page.nodes.get('#ticketModule').getBoundingClientRect=()=>({width:640,height:520});
  page.context.html2canvas=async()=>({toBlob:callback=>callback({type:'image/png'})});
  page.context.fetch=async()=>({ok:false,json:async()=>({error:'Disk full'})});
  await page.nodes.get('#captureTicket').onclick();
  assert(page.nodes.get('#state').textContent.includes('Screenshot failed: Disk full'));
  assert.equal(page.nodes.get('#notes').value,'Internal findings');
});
