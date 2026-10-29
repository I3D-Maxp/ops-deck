(function(root){
  const MAX_BYTES=5*1024*1024;
  const isObject=value=>value&&typeof value==='object'&&!Array.isArray(value);
  function ticket(value){
    if(value===null||value===undefined)return null;
    if(!isObject(value))throw Error('Invalid ticket in session.');
    const result={};
    for(const key of ['key','title','status','priority','type','description','assignee','reporter','created','updated','due','labels','components','location','rack','unit','serviceTag','requestType','url','sourceText','origin','syncedAt','commentMode']){
      if(value[key]!==undefined&&value[key]!==null)result[key]=String(value[key]);
    }
    if(Array.isArray(value.attachments))result.attachments=value.attachments.filter(file=>isObject(file)&&/^\d+$/.test(String(file.id))).slice(0,1000).map(file=>({
      id:String(file.id),filename:String(file.filename||'Attachment').slice(0,1000),mimeType:String(file.mimeType||'').slice(0,200),
      size:typeof file.size==='number'&&Number.isFinite(file.size)?Math.max(0,file.size):0,created:String(file.created||''),author:String(file.author||'')
    }));
    return result;
  }
  function validate(value){
    if(!isObject(value)||value.version!==1)throw Error('Choose an Aether Desk session backup (version 1).');
    if(!Array.isArray(value.tabs)||!Array.isArray(value.tools)||!isObject(value.drafts))throw Error('The session backup is incomplete.');
    if(value.tabs.length>1000||value.tools.length>1000||Object.keys(value.drafts).length>10000)throw Error('The session contains too many entries.');
    if(!Number.isFinite(Date.parse(value.savedAt)))throw Error('The session backup has no valid save date.');
    const tabs=value.tabs.map(tab=>{
      if(!isObject(tab)||typeof tab.label!=='string'||!tab.label.trim()||!isObject(tab.ticket))throw Error('Invalid saved ticket tab.');
      return {label:tab.label.slice(0,80),ticket:ticket(tab.ticket)};
    });
    const drafts=Object.create(null);
    for(const [key,draft]of Object.entries(value.drafts)){
      if(!isObject(draft)||typeof draft.customer!=='string'||typeof draft.work!=='string')throw Error('Invalid ticket draft.');
      drafts[key]={customer:draft.customer,work:draft.work,mode:draft.mode==='work'?'work':'customer'};
      if(isObject(draft.coordinates))drafts[key].coordinates=Object.fromEntries(['location','rack','unit','serviceTag'].filter(key=>typeof draft.coordinates[key]==='string').map(key=>[key,draft.coordinates[key].slice(0,1000)]));
      if(isObject(draft.coordinatePost)&&typeof draft.coordinatePost.body==='string')drafts[key].coordinatePost={body:draft.coordinatePost.body,id:String(draft.coordinatePost.id||''),created:String(draft.coordinatePost.created||'')};
      if(isObject(draft.sent)){
        drafts[key].sent={};
        for(const mode of ['customer','work'])if(isObject(draft.sent[mode])&&typeof draft.sent[mode].body==='string')drafts[key].sent[mode]={body:draft.sent[mode].body,id:String(draft.sent[mode].id||''),created:String(draft.sent[mode].created||'')};
      }
    }
    const tools=value.tools.map(tool=>{
      if(!isObject(tool)||typeof tool.name!=='string'||typeof tool.url!=='string'||!/^https?:\/\//i.test(tool.url))throw Error('Invalid custom tool.');
      return {name:tool.name,url:tool.url,icon:String(tool.icon||'Link')};
    });
    const layout={};
    if(isObject(value.layout))for(const id of ['import','ticket','draft','comments']) {
      const position=value.layout[id];
      if(!isObject(position))continue;
      if(!['x','y','z'].every(key=>typeof position[key]==='number'&&Number.isFinite(position[key])))continue;
      layout[id]={x:Math.max(0,Math.min(10000,position.x)),y:Math.max(0,Math.min(10000,position.y)),z:Math.max(1,Math.min(4,Math.round(position.z))),minimized:position.minimized===true};
    }
    const inputs=isObject(value.inputs)?value.inputs:{};
    const result={version:1,savedAt:new Date(value.savedAt).toISOString(),tabs,drafts,tools,currentTicket:ticket(value.currentTicket),autoRefresh:value.autoRefresh!==false,layout,mode:value.mode==='work'?'work':'customer',inputs:{jiraInput:String(inputs.jiraInput||''),raw:String(inputs.raw||''),tabLabel:String(inputs.tabLabel||''),commentFilter:['customer','work'].includes(inputs.commentFilter)?inputs.commentFilter:'all'}};
    if(JSON.stringify(result).length>MAX_BYTES)throw Error('The session is too large (maximum 5 MB).');
    return result;
  }
  const api={validate,MAX_BYTES};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.AetherSession=api;
})(typeof window!=='undefined'?window:globalThis);
