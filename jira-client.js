const fs=require('fs');
const path=require('path');
const definitions={
  location:{label:'Datacenter',names:['datacenter location','data center location','dc location single - internal','dc location single - external','dc location multi - internal','site / location']},
  rack:{label:'Rack',names:['rack number','cage/suite & rack number','rackname','rack name']},
  unit:{label:'Unit',names:['unit height','rack unit','unit position']},
  serviceTag:{label:'Service tag',names:['service tag','service tag number','serial number']}
};
const propertyKey='aether-desk.coordinates';
class JiraError extends Error{constructor(message,status=502,extra={}){super(message);this.status=status;Object.assign(this,extra);}}
function display(value){
  if(value==null)return '';
  if(Array.isArray(value))return value.map(display).filter(Boolean).join(', ');
  if(typeof value==='object')return String(value.value??value.label??value.name??value.displayName??'');
  return String(value);
}
function candidates(issue,metadata,coordinate){
  const def=definitions[coordinate];
  return Object.entries(issue.names||{}).map(([id,name])=>{
    const label=String(name).toLowerCase();
    const index=def.names.findIndex(pattern=>label===pattern||label.includes(pattern));
    if(index<0)return null;
    const meta=metadata?.fields?.[id];
    return {id,name,meta,schema:meta?.schema||issue.schema?.[id],value:issue.fields?.[id],score:100-index+(display(issue.fields?.[id])?20:0)};
  }).filter(Boolean).sort((a,b)=>b.score-a.score);
}
function buildCoordinates(issue,metadata,overrides={}){
  return Object.fromEntries(Object.keys(definitions).map(coordinate=>{
    const candidate=candidates(issue,metadata,coordinate).find(field=>field.meta?.operations?.includes('set')&&['string','number','option'].includes(field.schema?.type)&&!field.schema?.custom?.endsWith(':textarea')||field.meta?.operations?.includes('set')&&field.schema?.type==='array'&&field.schema?.items==='option');
    if(!candidate)return [coordinate,{label:definitions[coordinate].label,kind:'note',value:String(overrides[coordinate]??display(candidates(issue,null,coordinate)[0]?.value)),display:String(overrides[coordinate]??display(candidates(issue,null,coordinate)[0]?.value)),source:'Stored on this ticket and recorded in an internal work note'}];
    const kind=candidate.schema.type==='array'?'multi':candidate.schema.type==='option'?'option':candidate.schema.type==='number'?'number':'text';
    const options=(candidate.meta.allowedValues||[]).filter(option=>option.disabled!==true).map(option=>({id:String(option.id),label:display(option)}));
    const raw=kind==='multi'?(candidate.value||[]).map(value=>String(value.id)):kind==='option'?String(candidate.value?.id||''):candidate.value==null?'':String(candidate.value);
    return [coordinate,{label:definitions[coordinate].label,kind,value:raw,display:display(candidate.value),fieldId:candidate.id,options,required:candidate.meta.required===true,source:'Jira field: '+candidate.name}];
  }));
}
function createJiraClient({config,fetchImpl=fetch}={}){
  const locks=new Set();
  function settings(){
    let local=config;
    if(!local)try{local=require('dotenv').parse(fs.readFileSync(path.join(__dirname,'.env')));}catch(error){if(error.code==='ENOENT')local={};else throw new JiraError('Could not read the local Jira configuration.',503);}
    const resolved={...process.env,...local};
    if(!resolved.JIRA_BASE_URL||!resolved.JIRA_EMAIL||!resolved.JIRA_API_TOKEN)throw new JiraError('Jira is not configured. Add the Jira URL, email, and API token to .env.',503);
    const base=resolved.JIRA_BASE_URL.replace(/\/$/,'');
    if(!/^https:\/\/[^/]+/i.test(base))throw new JiraError('JIRA_BASE_URL must be an HTTPS Jira address.',503);
    return {base,headers:{Authorization:'Basic '+Buffer.from(resolved.JIRA_EMAIL+':'+resolved.JIRA_API_TOKEN).toString('base64'),Accept:'application/json','Content-Type':'application/json'}};
  }
  async function request(route,{method='GET',body,allow404=false}={}){
    const {base,headers}=settings();
    let response;
    try{response=await fetchImpl(base+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});}catch{throw new JiraError(method==='GET'?'Could not reach Jira. Your local work is kept.':'Jira did not confirm the action. Check the ticket in Jira before retrying to avoid duplicate posts.',502,{uncertain:method!=='GET'});}
    const result=await response.json().catch(()=>({}));
    if(allow404&&response.status===404)return null;
    if(!response.ok)throw new JiraError(result.errorMessage||result.errorMessages?.join(' ')||Object.values(result.errors||{}).join(' ')||result.message||`Jira returned ${response.status}.`,response.status);
    return result;
  }
  const issuePath=key=>'/rest/api/3/issue/'+encodeURIComponent(key);
  async function read(key,{editing=false}={}){
    const issue=await request(issuePath(key)+'?fields=*all&expand=names,schema');
    const [property,service,metadata]=await Promise.all([
      request(issuePath(key)+'/properties/'+propertyKey,{allow404:true}),
      request('/rest/servicedeskapi/request/'+encodeURIComponent(key),{allow404:true}).catch(error=>{if([400,403].includes(error.status))return null;throw error;}),
      editing?request(issuePath(key)+'/editmeta'):Promise.resolve(null)
    ]);
    const overrides=property?.value&&typeof property.value==='object'?property.value:{};
    const coordinates=buildCoordinates(issue,metadata,overrides);
    // For display reads, use native Jira values while preserving note-backed coordinates.
    if(!editing)for(const coordinate of Object.keys(definitions)){
      const field=candidates(issue,null,coordinate)[0];
      coordinates[coordinate].display=Object.hasOwn(overrides,coordinate)?String(overrides[coordinate]):display(field?.value);
    }
    return {baseUrl:settings().base,issue,coordinates,commentMode:service?'service':'unsupported',syncedAt:new Date().toISOString()};
  }
  async function getComments(key,{start=0}={}){
    if(!Number.isInteger(start)||start<0||start>100000)throw new JiraError('Invalid comment cursor.',400);
    const comments=[];let cursor=start;let hasMore=false;
    // Follow Jira pagination without trusting external next-page URLs.
    for(let page=0;page<10;page++){
      const result=await request('/rest/servicedeskapi/request/'+encodeURIComponent(key)+'/comment?public=true&internal=true&start='+cursor+'&limit=100');
      const values=Array.isArray(result.values)?result.values:[];
      for(const comment of values)comments.push({id:String(comment.id),body:typeof comment.body==='string'?comment.body:'',author:comment.author?.displayName||'Unknown author',created:comment.created?.iso8601||'',visibility:comment.public===true?'customer':comment.public===false?'work':'unknown'});
      cursor+=values.length;
      hasMore=result.isLastPage===false&&values.length>0;
      if(!hasMore)break;
    }
    comments.sort((a,b)=>(Date.parse(b.created)||0)-(Date.parse(a.created)||0));
    return {key,comments,nextStart:hasMore?cursor:null,complete:!hasMore,syncedAt:new Date().toISOString()};
  }
  async function getTransitions(key){
    const [issue,result]=await Promise.all([request(issuePath(key)+'?fields=status'),request(issuePath(key)+'/transitions?expand=transitions.fields')]);
    return {key,status:issue.fields?.status?.name||'',transitions:(result.transitions||[]).filter(transition=>transition.isAvailable!==false).map(transition=>({id:String(transition.id),name:String(transition.name||''),status:String(transition.to?.name||''),requiredFields:Object.entries(transition.fields||{}).filter(([,field])=>field.required).map(([id,field])=>({id,name:String(field.name||id)}))}))};
  }
  async function changeStatus(key,{transitionId,expectedStatus}){
    if(typeof transitionId!=='string'||!transitionId||transitionId.length>100||typeof expectedStatus!=='string')throw new JiraError('Choose a current Jira status transition.',400);
    const latest=await getTransitions(key);
    if(latest.status!==expectedStatus)throw new JiraError('The ticket status changed in Jira. Reopen the status dialog and review the available transitions.',409);
    const transition=latest.transitions.find(item=>item.id===transitionId);
    if(!transition)throw new JiraError('This status transition is no longer available. Reopen the status dialog.',409);
    if(transition.requiredFields.length)throw new JiraError('This transition requires '+transition.requiredFields.map(field=>field.name).join(', ')+'. Complete it in Jira.',400);
    await request(issuePath(key)+'/transitions',{method:'POST',body:{transition:{id:transition.id}}});
    return {changed:true,status:transition.status,transition:transition.name};
  }
  async function postComment(key,{visibility,body}){
    if(!['customer','work'].includes(visibility))throw new JiraError('Choose Customer reply or Work notes explicitly.',400);
    if(typeof body!=='string'||!body.trim()||body.length>30000)throw new JiraError('Write a comment between 1 and 30,000 characters.',400);
    const result=await request('/rest/servicedeskapi/request/'+encodeURIComponent(key)+'/comment',{method:'POST',body:{body,public:visibility==='customer'}});
    if(typeof result.public!=='boolean'||result.public!==(visibility==='customer'))throw new JiraError('Jira did not confirm the expected comment visibility. Check the ticket before posting again.',502,{uncertain:true});
    return {id:String(result.id),visibility,body:result.body||body,created:result.created?.iso8601||new Date().toISOString()};
  }
  async function changeCoordinate(key,{coordinate,value,expectedValue,addWorkNote=false}){
    if(typeof addWorkNote!=='boolean')throw new JiraError('The work-note choice must be on or off.',400);
    if(!Object.hasOwn(definitions,coordinate))throw new JiraError('Unknown work coordinate.',400);
    if(locks.has(key))throw new JiraError('A coordinate change is already in progress for this ticket.',409);
    locks.add(key);
    try{
      const latest=await read(key,{editing:true});
      if(latest.commentMode!=='service')throw new JiraError('This ticket does not support Jira Service Management internal work notes.',400);
      const field=latest.coordinates[coordinate];
      if(JSON.stringify(field.value)!==JSON.stringify(expectedValue))throw new JiraError('This coordinate changed in Jira. Refresh and review the current value before saving.',409);
      let payload,pretty;
      if(field.kind==='multi'){
        if(!Array.isArray(value)||value.some(id=>typeof id!=='string'))throw new JiraError('Choose valid coordinate options.',400);
        const selected=[...new Set(value)].map(id=>field.options.find(option=>option.id===id));
        if(selected.some(option=>!option))throw new JiraError('An option is no longer available. Refresh the editor.',400);
        if(field.required&&!selected.length)throw new JiraError('This Jira field is required.',400);
        payload=selected.map(option=>({id:option.id}));pretty=selected.map(option=>option.label).join(', ');
      }else if(field.kind==='option'){
        const selected=field.options.find(option=>option.id===value);
        if(value&&!selected)throw new JiraError('Choose an available Jira option.',400);
        if(field.required&&!value)throw new JiraError('This Jira field is required.',400);
        payload=selected?{id:selected.id}:null;pretty=selected?.label||'';
      }else{
        if(typeof value!=='string'||value.length>1000)throw new JiraError('Enter a coordinate of up to 1,000 characters.',400);
        pretty=value.trim();
        if(field.required&&!pretty)throw new JiraError('This Jira field is required.',400);
        payload=field.kind==='number'?(pretty?Number(pretty):null):pretty;
        if(field.kind==='number'&&payload!==null&&!Number.isFinite(payload))throw new JiraError('Enter a valid number.',400);
      }
      const comparable=field.kind==='multi'?[...value].sort():typeof value==='string'?value.trim():value;
      const oldComparable=field.kind==='multi'?[...field.value].sort():field.value;
      if(JSON.stringify(comparable)===JSON.stringify(oldComparable))return {changed:false,notePosted:false};
      const note=definitions[coordinate].label+' coordinate changed to '+JSON.stringify(pretty||'(cleared)');
      if(field.kind==='note'){
        const property=await request(issuePath(key)+'/properties/'+propertyKey,{allow404:true});
        await request(issuePath(key)+'/properties/'+propertyKey,{method:'PUT',body:{...(property?.value||{}),[coordinate]:pretty}});
      }else await request(issuePath(key),{method:'PUT',body:{fields:{[field.fieldId]:payload}}});
      if(!addWorkNote)return {changed:true,notePosted:false,noteRequested:false};
      try{
        const comment=await postComment(key,{visibility:'work',body:note});
        return {changed:true,notePosted:true,noteRequested:true,comment,note};
      }catch(error){
        return {changed:true,notePosted:false,noteRequested:true,note,warning:'The coordinate was saved, but Jira did not confirm the internal note. Check Jira before posting the note again.',uncertain:error.uncertain===true};
      }
    }finally{locks.delete(key);}
  }
  async function getQueue({cursor='',filterId='',queue='unassigned'}={}){
    if(!['unassigned','mine','hardware'].includes(queue))throw new JiraError('Unknown queue.',400);
    if(typeof cursor!=='string'||cursor.length>4096||typeof filterId!=='string'||(filterId&&!/^\d+$/.test(filterId)))throw new JiraError('Invalid queue page. Refresh the queue.',400);
    const dashboardId='12754',gadgetId=queue==='hardware'?'59736':queue==='mine'?'59711':'59715';
    const gadget=await request('/rest/api/3/dashboard/'+dashboardId+'/items/'+gadgetId+'/properties/config');
    const id=String(gadget.value?.filterId||'');
    if(!/^\d+$/.test(id))throw new JiraError('This dashboard gadget has no saved filter configured.',422);
    if(cursor&&filterId!==id)throw new JiraError('The dashboard filter changed. Refresh the queue before loading more.',409);
    const filter=await request('/rest/api/3/filter/'+id);
    if(typeof filter.jql!=='string'||!filter.jql.trim())throw new JiraError('The saved queue filter has no readable query.',422);
    const query=new URLSearchParams({jql:filter.jql,maxResults:'25',fields:'summary,status,priority,assignee,created,duedate'});
    if(cursor)query.set('nextPageToken',cursor);
    const result=await request('/rest/api/3/search/jql?'+query);
    if(!Array.isArray(result.issues))throw new JiraError('Jira returned an invalid queue. Refresh to try again.',502);
    return {filterId:id,name:String(filter.name||'Active unassigned tasks'),sourceUrl:settings().base+'/jira/dashboards/12754?maximized='+gadgetId,issues:result.issues.map(issue=>({
      key:String(issue.key||''),title:String(issue.fields?.summary||'Untitled'),status:display(issue.fields?.status),priority:display(issue.fields?.priority),assignee:display(issue.fields?.assignee)||'Unassigned',assigneeId:issue.fields?.assignee?String(issue.fields.assignee.accountId||'unknown'):null,created:String(issue.fields?.created||''),due:String(issue.fields?.duedate||'')
    })),nextPageToken:result.isLast===true?null:typeof result.nextPageToken==='string'&&result.nextPageToken?result.nextPageToken:null,syncedAt:new Date().toISOString()};
  }
  async function assignToMe(key){
    if(locks.has(key))throw new JiraError('An update is already running for this ticket.',409);
    locks.add(key);
    try{
      const me=await request('/rest/api/3/myself');
      if(typeof me.accountId!=='string'||!me.accountId||me.active===false)throw new JiraError('Could not identify your active Jira account.',403);
      const latest=await request(issuePath(key)+'?fields=assignee');
      if(!latest.fields||!Object.hasOwn(latest.fields,'assignee'))throw new JiraError('Jira did not return the current assignee. Refresh before assigning.',502);
      const assignee=latest.fields.assignee;
      if(assignee?.accountId===me.accountId)return {key,changed:false,assignee:display(assignee),accountId:me.accountId};
      if(assignee)throw new JiraError('This ticket is already assigned to '+(display(assignee)||'another user')+'. Refresh the queue.',409);
      await request(issuePath(key)+'/assignee',{method:'PUT',body:{accountId:me.accountId}});
      let confirmed;
      try{confirmed=await request(issuePath(key)+'?fields=assignee');}
      catch{throw new JiraError('Jira accepted the assignment but verification failed. Check Jira before retrying.',502,{uncertain:true});}
      if(confirmed.fields?.assignee?.accountId!==me.accountId)throw new JiraError('Jira did not confirm you as the assignee. Check Jira before retrying.',502,{uncertain:true});
      return {key,changed:true,assignee:display(confirmed.fields.assignee),accountId:me.accountId};
    }finally{locks.delete(key);}
  }
  async function getAttachment(key,id,{signal}={}){
    if(typeof id!=='string'||!/^\d+$/.test(id))throw new JiraError('Invalid attachment ID.',400);
    const issue=await request(issuePath(key)+'?fields=attachment');
    const attachment=(Array.isArray(issue.fields?.attachment)?issue.fields.attachment:[]).find(item=>String(item.id)===id);
    if(!attachment)throw new JiraError('This attachment is no longer available on this ticket.',404);
    const {base,headers}=settings();
    let response;
    try{
      response=await fetchImpl(base+'/rest/api/3/attachment/content/'+id+'?redirect=false',{
        method:'GET',headers:{Authorization:headers.Authorization,Accept:'*/*'},redirect:'error',
        signal:signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)
      });
    }catch{throw new JiraError('Could not download the attachment from Jira. Try again or open the ticket in Jira.',502);}
    if(!response.ok){await response.body?.cancel?.();throw new JiraError('Jira could not provide this attachment (HTTP '+response.status+').',response.status);}
    return {attachment,response};
  }
  return {read,postComment,changeCoordinate,getComments,getTransitions,changeStatus,getQueue,assignToMe,getAttachment};
}
module.exports={createJiraClient,JiraError,buildCoordinates,display};
