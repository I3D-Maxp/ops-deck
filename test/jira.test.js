const test=require('node:test');
const assert=require('node:assert/strict');
const {createJiraClient}=require('../jira-client');
const {createJiraRouter}=require('../jira-routes');
const config={JIRA_BASE_URL:'https://jira.example.com',JIRA_EMAIL:'test@example.com',JIRA_API_TOKEN:'test-only'};
const issue={key:'ITSM-101',names:{customfield_1:'DC Location Single - Internal',customfield_2:'Rackname'},schema:{customfield_1:{type:'option'},customfield_2:{type:'string'}},fields:{summary:'Example',reporter:{displayName:'Taylor Example'},customfield_1:{id:'10',value:'AMS'},customfield_2:'R01'}};
const metadata={fields:{customfield_1:{name:'DC Location Single - Internal',schema:{type:'option'},operations:['set'],allowedValues:[{id:'10',value:'AMS'},{id:'20',value:'FRA'}]},customfield_2:{name:'Rackname',schema:{type:'string'},operations:['set']}}};
function mockClient({failNote=false,wrongVisibility=false,failNetwork=false}={}){
 const calls=[];let property={};
 const client=createJiraClient({config,fetchImpl:async(url,options)=>{
  const route=new URL(url).pathname;const body=options.body?JSON.parse(options.body):null;calls.push({route,method:options.method,body});
  const ok=(data,status=200)=>({ok:status<400,status,json:async()=>data});
  if(route.endsWith('/comment')){
   if(failNetwork)throw Error('Network');
   if(failNote)return ok({errorMessage:'No comment permission'},403);
   return ok({id:'700',public:wrongVisibility?!body.public:body.public,body:body.body,created:{iso8601:'2026-10-27T10:00:00.000Z'}},201);
  }
  if(route.endsWith('/editmeta'))return ok(metadata);
  if(route.includes('/properties/')){if(options.method==='PUT'){property=body;return ok({},201);}return ok({value:property});}
  if(route.includes('/servicedeskapi/request/'))return ok({issueKey:'ITSM-101'});
  if(options.method==='PUT')return ok({},204);
  return ok(issue);
 }});
 return {client,calls,get property(){return property;}};
}
test('Jira read expands readable field names, detects service requests and finds native coordinates',async()=>{
 const {client,calls}=mockClient();const loaded=await client.read('ITSM-101');
 assert.equal(loaded.commentMode,'service');assert.equal(loaded.coordinates.location.display,'AMS');assert.equal(loaded.coordinates.rack.display,'R01');
 assert(calls.every(call=>call.method==='GET'));
 const editable=await client.read('ITSM-101',{editing:true});assert.equal(editable.coordinates.location.kind,'option');assert.equal(editable.coordinates.rack.kind,'text');assert.equal(editable.coordinates.unit.kind,'note');
});
test('customer and internal comments always use explicit Service Management visibility',async()=>{
 const {client,calls}=mockClient();
 await client.postComment('ITSM-101',{visibility:'customer',body:'Hello Taylor,\n\nUpdate\n\nThank you.'});
 await client.postComment('ITSM-101',{visibility:'work',body:'Internal diagnostic details'});
 const posts=calls.filter(call=>call.method==='POST');assert.equal(posts[0].body.public,true);assert.equal(posts[1].body.public,false);
 assert(posts.every(call=>call.route==='/rest/servicedeskapi/request/ITSM-101/comment'));
 await assert.rejects(()=>client.postComment('ITSM-101',{body:'No explicit visibility'}));
 await assert.rejects(()=>client.postComment('ITSM-101',{visibility:'customer',body:'  '}));
});
test('unconfirmed visibility and uncertain network writes are never reported as success',async()=>{
 const wrong=mockClient({wrongVisibility:true});await assert.rejects(()=>wrong.client.postComment('ITSM-101',{visibility:'work',body:'Private'}),error=>error.uncertain===true);
 const network=mockClient({failNetwork:true});await assert.rejects(()=>network.client.postComment('ITSM-101',{visibility:'work',body:'Private'}),error=>error.uncertain===true);
});
test('native coordinate changes validate current value and write a separate internal audit note',async()=>{
 const {client,calls}=mockClient();const result=await client.changeCoordinate('ITSM-101',{coordinate:'location',value:'20',expectedValue:'10',addWorkNote:true});
 assert.equal(result.notePosted,true);assert.equal(result.note,'Datacenter coordinate changed to "FRA"');
 const put=calls.find(call=>call.method==='PUT');assert.deepEqual(put.body,{fields:{customfield_1:{id:'20'}}});
 const comment=calls.find(call=>call.method==='POST');assert.equal(comment.body.public,false);assert.equal(comment.body.body,result.note);
});
test('missing Jira coordinate fields use ticket-stored data plus an internal note',async()=>{
 const mock=mockClient();const result=await mock.client.changeCoordinate('ITSM-101',{coordinate:'serviceTag',value:'SV-123',expectedValue:'',addWorkNote:true});
 assert.equal(mock.property.serviceTag,'SV-123');assert.equal(result.notePosted,true);assert(result.note.includes('SV-123'));
});
test('stale values and invalid option identifiers prevent all Jira writes',async()=>{
 const {client,calls}=mockClient();
 await assert.rejects(()=>client.changeCoordinate('ITSM-101',{coordinate:'location',value:'20',expectedValue:'old'}),error=>error.status===409);
 await assert.rejects(()=>client.changeCoordinate('ITSM-101',{coordinate:'location',value:'bad-option',expectedValue:'10'}),error=>error.status===400);
 assert(calls.every(call=>call.method==='GET'));
});
test('coordinate success with failed note is reported as partial and leaves a recoverable note',async()=>{
 const {client,calls}=mockClient({failNote:true});const result=await client.changeCoordinate('ITSM-101',{coordinate:'rack',value:'R02',expectedValue:'R01',addWorkNote:true});
 assert.equal(result.changed,true);assert.equal(result.notePosted,false);assert(result.warning);assert.equal(result.note,'Rack coordinate changed to "R02"');
 assert.equal(calls.filter(call=>call.method==='PUT').length,1);
});
test('unchanged coordinates do not cause fields or comments to be written',async()=>{
 const {client,calls}=mockClient();const result=await client.changeCoordinate('ITSM-101',{coordinate:'rack',value:'R01',expectedValue:'R01'});
 assert.equal(result.changed,false);assert(calls.every(call=>call.method==='GET'));
});
test('local Jira routes reject foreign origins before calling any Jira write method',async t=>{
 const express=require('express');let writes=0;
 const app=express();app.use(express.json());app.use('/api/ticket',createJiraRouter({client:{postComment:async()=>{writes++;return {};}}}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/api/ticket/ITSM-101/comments`;
 const response=await fetch(url,{method:'POST',headers:{Origin:'https://unrelated.example','Content-Type':'application/json'},body:JSON.stringify({visibility:'work',body:'Must not be sent'})});
 assert.equal(response.status,403);assert.equal(writes,0);
});

test('comment retrieval follows pagination and keeps public/internal visibility and chronological order',async()=>{
  const calls=[];
  const client=createJiraClient({config,fetchImpl:async(url,options)=>{
    assert.equal(options.method,'GET');const query=new URL(url).searchParams;const start=Number(query.get('start'));calls.push(start);
    assert.equal(query.get('public'),'true');assert.equal(query.get('internal'),'true');
    const data=start===0?{values:[{id:'1',body:'Public response',public:true,author:{displayName:'Taylor'},created:{iso8601:'2026-10-28T09:00:00Z'}}],isLastPage:false}:{values:[{id:'2',body:'Internal diagnostic',public:false,author:{displayName:'Operator'},created:{iso8601:'2026-10-28T10:00:00Z'}}],isLastPage:true};
    return {ok:true,status:200,json:async()=>data};
  }});
  const result=await client.getComments('ITSM-101');
  assert.deepEqual(calls,[0,1]);assert.equal(result.comments[0].visibility,'work');assert.equal(result.comments[1].visibility,'customer');assert.equal(result.comments[0].author,'Operator');assert.equal(result.nextStart,null);assert.equal(result.complete,true);
});
test('long comment histories return a continuation cursor and invalid cursors cause no requests',async()=>{
  let reads=0;
  const client=createJiraClient({config,fetchImpl:async(url)=>{reads++;const start=Number(new URL(url).searchParams.get('start'));return {ok:true,status:200,json:async()=>({values:[{id:String(start),body:'Comment',public:true}],isLastPage:false})};}});
  const result=await client.getComments('ITSM-101');assert.equal(reads,10);assert.equal(result.nextStart,10);assert.equal(result.complete,false);
  await assert.rejects(()=>client.getComments('ITSM-101',{start:-1}),error=>error.status===400);assert.equal(reads,10);
});

test('status transitions come from Jira and status updates submit the permitted transition ID',async()=>{
  const writes=[];
  const client=createJiraClient({config,fetchImpl:async(url,options)=>{
    const route=new URL(url).pathname;
    if(options.method==='POST'){writes.push(JSON.parse(options.body));return {ok:true,status:204,json:async()=>({})};}
    return {ok:true,status:200,json:async()=>route.endsWith('/transitions')?{transitions:[{id:'21',name:'Resolve',to:{name:'Resolved'},fields:{}},{id:'31',name:'Close',to:{name:'Closed'},fields:{resolution:{required:true,name:'Resolution'}}}]}:{fields:{status:{name:'In Progress'}}}};
  }});
  const choices=await client.getTransitions('ITSM-101');assert.equal(choices.status,'In Progress');assert.equal(choices.transitions[1].requiredFields[0].name,'Resolution');
  await assert.rejects(()=>client.changeStatus('ITSM-101',{transitionId:'21',expectedStatus:'New'}),error=>error.status===409);
  await assert.rejects(()=>client.changeStatus('ITSM-101',{transitionId:'not-allowed',expectedStatus:'In Progress'}),error=>error.status===409);
  await assert.rejects(()=>client.changeStatus('ITSM-101',{transitionId:'31',expectedStatus:'In Progress'}),error=>error.status===400);
  assert.equal(writes.length,0);
  const result=await client.changeStatus('ITSM-101',{transitionId:'21',expectedStatus:'In Progress'});
  assert.equal(result.status,'Resolved');assert.deepEqual(writes,[{transition:{id:'21'}}]);
});

test('coordinate changes without work-note opt-in never create comments',async()=>{
  for(const change of [{coordinate:'rack',value:'R02',expectedValue:'R01'},{coordinate:'serviceTag',value:'SV-456',expectedValue:'',addWorkNote:false}]){
    const {client,calls}=mockClient({failNote:true});
    const result=await client.changeCoordinate('ITSM-101',change);
    assert.equal(result.changed,true);assert.equal(result.notePosted,false);assert.equal(result.noteRequested,false);assert.equal(result.warning,undefined);
    assert.equal(calls.filter(call=>call.method==='POST').length,0);
    assert.equal(calls.filter(call=>call.method==='PUT').length,1);
  }
});
test('coordinate note opt-in must be an actual boolean',async()=>{
  const {client,calls}=mockClient();
  await assert.rejects(()=>client.changeCoordinate('ITSM-101',{coordinate:'rack',value:'R02',expectedValue:'R01',addWorkNote:'false'}),error=>error.status===400);
  assert.equal(calls.length,0);
});

test('live queue reads the exact dashboard filter and preserves its Jira ordering with cursor pagination',async()=>{
  const calls=[];
  const client=createJiraClient({config,fetchImpl:async(url,options)=>{
    assert.equal(options.method,'GET');const u=new URL(url);calls.push(u);
    let result;
    if(u.pathname.endsWith('/properties/config'))result={value:{filterId:'20741'}};
    else if(u.pathname.endsWith('/filter/20741'))result={name:'Unassigned tasks',jql:'project = ITSM AND assignee IS EMPTY ORDER BY created ASC'};
    else{assert.equal(u.pathname,'/rest/api/3/search/jql');assert.equal(u.searchParams.get('maxResults'),'25');assert(u.searchParams.get('jql').endsWith('ORDER BY created ASC'));result={issues:[{key:'ITSM-202',fields:{summary:'Older',status:{name:'Open'},priority:{name:'High'},assignee:null}},{key:'ITSM-101',fields:{summary:'Newer'}}],nextPageToken:'next/+ token',isLast:false};}
    return {ok:true,status:200,json:async()=>result};
  }});
  const result=await client.getQueue();
  assert.equal(result.filterId,'20741');assert.equal(result.name,'Unassigned tasks');
  assert.deepEqual(result.issues.map(issue=>issue.key),['ITSM-202','ITSM-101']);
  assert.equal(result.issues[0].assignee,'Unassigned');
  assert.equal(result.nextPageToken,'next/+ token');
  await client.getQueue({cursor:result.nextPageToken,filterId:'20741'});
  assert.equal(calls.at(-1).searchParams.get('nextPageToken'),'next/+ token');
  const previous=calls.length;
  await assert.rejects(()=>client.getQueue({cursor:['bad']}),error=>error.status===400);
  assert.equal(calls.length,previous);
  await assert.rejects(()=>client.getQueue({cursor:'old',filterId:'999'}),error=>error.status===409);
});
test('live queue reports missing dashboard configuration and Jira permissions instead of inventing a query',async()=>{
  let reads=0;
  const client=createJiraClient({config,fetchImpl:async()=>{reads++;return {ok:true,status:200,json:async()=>({value:{}})};}});
  await assert.rejects(()=>client.getQueue(),error=>error.status===422);assert.equal(reads,1);
  const denied=createJiraClient({config,fetchImpl:async()=>({ok:false,status:403,json:async()=>({errorMessages:['No permission']})})});
  await assert.rejects(()=>denied.getQueue(),error=>error.status===403&&error.message==='No permission');
});
test('live queue route is accessible locally, validates cursor types and rejects foreign origins',async t=>{
  const express=require('express');const app=express();let reads=0;
  app.use('/api/ticket',createJiraRouter({client:{getQueue:async params=>{reads++;return {issues:[],...params};}}}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port+'/api/ticket/queue';
  const response=await fetch(url+'?cursor=next&filterId=20741');
  assert.equal(response.status,200);assert.equal((await response.json()).filterId,'20741');assert.equal(reads,1);
  const denied=await fetch(url,{headers:{Origin:'https://unrelated.example'}});assert.equal(denied.status,403);assert.equal(reads,1);
});

test('My tickets resolves gadget 59711 and uses its currentUser filter without altering its order',async()=>{
  const calls=[];
  const client=createJiraClient({config,fetchImpl:async(url,options)=>{
    const u=new URL(url);calls.push(u);assert.equal(options.method,'GET');
    let result;
    if(u.pathname.endsWith('/59711/properties/config'))result={value:{filterId:'20746'}};
    else if(u.pathname.endsWith('/filter/20746'))result={name:'My active tasks',jql:'assignee = currentUser() ORDER BY created DESC'};
    else {assert.equal(u.pathname,'/rest/api/3/search/jql');assert.equal(u.searchParams.get('jql'),'assignee = currentUser() ORDER BY created DESC');result={issues:[{key:'ITSM-101',fields:{assignee:{accountId:'me',displayName:'Me'}}}],isLast:true};}
    return {ok:true,status:200,json:async()=>result};
  }});
  const result=await client.getQueue({queue:'mine'});
  assert.equal(result.filterId,'20746');assert(result.sourceUrl.endsWith('59711'));assert.equal(result.issues[0].assigneeId,'me');
  await assert.rejects(()=>client.getQueue({queue:'arbitrary'}),error=>error.status===400);assert.equal(calls.length,3);
});
function assignmentClient({assignee=null,failPut=0,failVerify=false,wrongVerify=false}={}){
  const calls=[];let assigned=assignee,put=false;
  const client=createJiraClient({config,fetchImpl:async(url,options)=>{
    calls.push({url,method:options.method,body:options.body?JSON.parse(options.body):null});
    if(url.endsWith('/myself'))return {ok:true,status:200,json:async()=>({accountId:'me',displayName:'My Name',active:true})};
    if(options.method==='PUT'){
      put=true;
      if(failPut===-1)throw Error('Connection lost');
      if(failPut)return {ok:false,status:failPut,json:async()=>({errorMessages:['Assignment denied']})};
      assigned={accountId:wrongVerify?'other':'me',displayName:'My Name'};
      return {ok:true,status:204,json:async()=>{throw Error('Empty');}};
    }
    if(put&&failVerify)throw Error('Offline');
    return {ok:true,status:200,json:async()=>({fields:{assignee:assigned}})};
  }});
  return {client,calls};
}
test('self-assignment resolves the configured user, updates only assignee and verifies the result',async()=>{
  const {client,calls}=assignmentClient();const result=await client.assignToMe('ITSM-101');
  assert.equal(result.changed,true);assert.equal(result.accountId,'me');
  const writes=calls.filter(call=>call.method!=='GET');assert.equal(writes.length,1);
  assert(writes[0].url.endsWith('/ITSM-101/assignee'));assert.deepEqual(writes[0].body,{accountId:'me'});
  assert.equal(calls.at(-1).method,'GET');
});
test('self-assignment is idempotent and refuses tickets already assigned to someone else',async()=>{
  const mine=assignmentClient({assignee:{accountId:'me',displayName:'My Name'}});
  assert.equal((await mine.client.assignToMe('ITSM-101')).changed,false);assert(mine.calls.every(call=>call.method==='GET'));
  const other=assignmentClient({assignee:{accountId:'other',displayName:'Other User'}});
  await assert.rejects(()=>other.client.assignToMe('ITSM-101'),error=>error.status===409);
  assert(other.calls.every(call=>call.method==='GET'));
});
test('self-assignment preserves permission failures and marks unconfirmed writes as uncertain',async()=>{
  const denied=assignmentClient({failPut:403});
  await assert.rejects(()=>denied.client.assignToMe('ITSM-101'),error=>error.status===403&&!error.uncertain);
  for(const options of [{failPut:-1},{failVerify:true},{wrongVerify:true}]){
    const {client,calls}=assignmentClient(options);
    await assert.rejects(()=>client.assignToMe('ITSM-101'),error=>error.uncertain===true);
    assert.equal(calls.filter(call=>call.method==='PUT').length,1);
  }
});
test('self-assignment route uses only the ticket key and configured identity, rejecting foreign callers',async t=>{
  const express=require('express');const app=express();app.use(express.json());const assigned=[];
  app.use('/api/ticket',createJiraRouter({client:{assignToMe:async(...args)=>{assigned.push(args);return {changed:true};}}}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port+'/api/ticket/';
  const options={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId:'someone-else'})};
  const accepted=await fetch(base+'ITSM-101/assign-to-me',options);assert.equal(accepted.status,200);assert.deepEqual(assigned,[['ITSM-101']]);
  const denied=await fetch(base+'ITSM-101/assign-to-me',{...options,headers:{...options.headers,Origin:'https://unrelated.example'}});assert.equal(denied.status,403);
  const invalid=await fetch(base+'bad/assign-to-me',options);assert.equal(invalid.status,400);assert.equal(assigned.length,1);
});

test('Hardware alerts resolves gadget 59736 and executes its saved filter query',async()=>{
  const client=createJiraClient({config,fetchImpl:async(url,options)=>{
    const u=new URL(url);assert.equal(options.method,'GET');
    let data;
    if(u.pathname.endsWith('/59736/properties/config'))data={value:{filterId:'30000'}};
    else if(u.pathname.endsWith('/filter/30000'))data={name:'Hardware alerts',jql:'component = "Hardware Alert" ORDER BY created DESC'};
    else{assert.equal(u.pathname,'/rest/api/3/search/jql');assert.equal(u.searchParams.get('jql'),'component = "Hardware Alert" ORDER BY created DESC');data={issues:[{key:'ITSM-303',fields:{summary:'Hardware failure',assignee:null}}],isLast:true};}
    return {ok:true,status:200,json:async()=>data};
  }});
  const result=await client.getQueue({queue:'hardware'});
  assert.equal(result.filterId,'30000');assert(result.sourceUrl.endsWith('59736'));
  assert.equal(result.issues[0].key,'ITSM-303');assert.equal(result.issues[0].assigneeId,null);
});

test('attachment reads validate membership and fetch only the authenticated Jira content endpoint',async()=>{
  const calls=[];
  const client=createJiraClient({config,fetchImpl:async(url,options)=>{
    calls.push({url,options});
    if(url.includes('?fields=attachment'))return {ok:true,json:async()=>({fields:{attachment:[{id:'500',filename:'photo.png',mimeType:'image/png',content:'https://untrusted.example/file'}]}})};
    assert.equal(url,'https://jira.example.com/rest/api/3/attachment/content/500?redirect=false');
    assert.equal(options.redirect,'error');assert(options.headers.Authorization.startsWith('Basic '));
    return new Response(new Uint8Array([0,1,128,255]));
  }});
  const result=await client.getAttachment('ITSM-101','500');
  assert.equal(result.attachment.filename,'photo.png');
  assert.deepEqual([...new Uint8Array(await result.response.arrayBuffer())],[0,1,128,255]);
  const before=calls.length;
  await assert.rejects(()=>client.getAttachment('ITSM-101','../500'),error=>error.status===400);
  assert.equal(calls.length,before);
  await assert.rejects(()=>client.getAttachment('ITSM-101','999'),error=>error.status===404);
  assert.equal(calls.length,before+1);
});
test('attachment permission failures remain explicit and do not return file contents',async()=>{
  const client=createJiraClient({config,fetchImpl:async url=>url.includes('?fields=attachment')?{ok:true,json:async()=>({fields:{attachment:[{id:'500'}]}})}:new Response('Denied',{status:403})});
  await assert.rejects(()=>client.getAttachment('ITSM-101','500'),error=>error.status===403);
});
test('attachment routes stream bytes, support downloads and prevent active file content on the app origin',async t=>{
  const express=require('express'),app=express();let reads=0;
  const client={getAttachment:async(key,id)=>{
    reads++;assert.equal(key,'ITSM-101');
    if(id==='404')throw Object.assign(Error('File removed'),{status:404});
    return {attachment:{filename:id==='2'?'unsafe.html':'photo.png',mimeType:id==='2'?'text/html':'image/png'},response:new Response(new Uint8Array([0,128,255]))};
  }};
  app.use('/api/ticket',createJiraRouter({client}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port+'/api/ticket/ITSM-101/attachments/';
  const image=await fetch(url+'1');assert.equal(image.status,200);assert(image.headers.get('content-disposition').startsWith('inline'));
  assert.equal(image.headers.get('content-type'),'image/png');assert.equal(image.headers.get('x-content-type-options'),'nosniff');
  assert.equal(image.headers.get('cache-control'),'no-store');assert.deepEqual([...new Uint8Array(await image.arrayBuffer())],[0,128,255]);
  const download=await fetch(url+'1?download=1');assert(download.headers.get('content-disposition').startsWith('attachment'));await download.arrayBuffer();
  const html=await fetch(url+'2');assert.equal(html.headers.get('content-type'),'application/octet-stream');assert(html.headers.get('content-disposition').startsWith('attachment'));await html.arrayBuffer();
  const missing=await fetch(url+'404');assert.equal(missing.status,404);assert.equal((await missing.json()).error,'File removed');
  const before=reads;const denied=await fetch(url+'1',{headers:{Origin:'https://unrelated.example'}});assert.equal(denied.status,403);assert.equal(reads,before);
});
