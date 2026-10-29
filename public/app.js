const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
const savedStore = readJSON('opsDeck', {});
const store = {tools: Array.isArray(savedStore.tools) ? savedStore.tools : []};
let currentTicket = null;
let ticketLoadVersion = 0;
let ticketInputStage='idle';
let ticketInputTimer=null;
let mode = 'customer';
let drafts = readJSON('opsDeckDrafts', {});
let sessionReady=false;
let sessionTimer=null;
let pendingSession=null;
let sessionSaving=false;
let pendingRestore=null;
let deskLayout=readJSON('aetherDeskLayout',{});
let layoutManager=null;
let jiraSyncBusy=false;
let jiraPosting=false;
let pendingJiraPost=null;
let coordinateEditor=null;
let coordinateSaving=false;
let coordinateSnapshotPosting=false;
const coordinateFeedback=new Map();
let statusEditor=null;
let statusSaving=false;
const storedTabs = readJSON('aetherDeskTicketTabs', []);
let ticketTabs = Array.isArray(storedTabs) ? storedTabs.filter(tab => tab && typeof tab.label === 'string' && tab.ticket && typeof tab.ticket === 'object' && typeof tab.ticket.title === 'string') : [];

const keyFrom = value => ((String(value || '').match(/\b[A-Z][A-Z0-9]+-\d+\b/i) || [])[0] || '').toUpperCase();
const textADF = node => {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textADF).join('');
  return (node.text || '') + (node.content ? textADF(node.content) : '') + (['paragraph','heading','listItem','hardBreak'].includes(node.type) ? '\n' : '');
};
function value(entry) {
  if(entry===null||entry===undefined)return '';
  if(Array.isArray(entry))return entry.map(value).filter(Boolean).join(', ');
  if(typeof entry!=='object')return String(entry);
  for(const candidate of [entry.requestType?.name,entry.name,entry.displayName,entry.value,entry.label]){
    const text=value(candidate);if(text)return text;
  }
  return '';
}
function custom(fields, patterns) {
  for (const [id, entry] of Object.entries(fields)) {
    const label = (window.fieldNames?.[id] || id).toLowerCase();
    if (patterns.some(pattern => label.includes(pattern)) && entry) return value(entry);
  }
  return '';
}
function normalise(payload) {
  const issue = payload.issue, fields = issue.fields || {};
  window.fieldNames = issue.names || {};
  return {
    key:issue.key,title:fields.summary,status:fields.status?.name,priority:fields.priority?.name,type:fields.issuetype?.name,
    description:textADF(fields.description).trim(),assignee:fields.assignee?.displayName,reporter:fields.reporter?.displayName,
    updated:fields.updated,due:fields.duedate,labels:(fields.labels || []).join(', '),components:(fields.components || []).map(item=>item.name).join(', '),
    location:custom(fields,['datacenter location','data center location','site / location']),rack:custom(fields,['rack number','cage/suite']),
    unit:custom(fields,['unit height']),serviceTag:custom(fields,['service tag']),requestType:custom(fields,['request type']),
    url:`${payload.baseUrl}/browse/${issue.key}`,
    attachments:Array.isArray(fields.attachment)?fields.attachment.map(file=>({id:String(file.id),filename:String(file.filename||'Attachment'),mimeType:String(file.mimeType||''),size:Number(file.size)||0,created:String(file.created||''),author:String(file.author?.displayName||'')})).filter(file=>/^\d+$/.test(file.id)):undefined,
    origin:'jira',syncedAt:payload.syncedAt,commentMode:payload.commentMode,
    ...Object.fromEntries(['location','rack','unit','serviceTag'].filter(key=>payload.coordinates?.[key]).map(key=>[key,payload.coordinates[key].display]))
  };
}
function ticketDate(raw) {
  if(!raw)return '';
  const dateOnly=/^\d{4}-\d{2}-\d{2}$/.test(raw);
  const date=new Date(dateOnly?raw+'T12:00:00':raw);
  return Number.isFinite(date.getTime())?dateOnly?date.toLocaleDateString(undefined,{dateStyle:'medium'}):date.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):String(raw);
}
function secondaryTicketDetails(ticket) {
  const type=value(ticket.requestType);
  const entries=[['Priority',ticket.priority],['Request type',type&&type!=='[object Object]'?type:ticket.type],['Assignee',ticket.assignee],['Reporter',ticket.reporter],['Updated',ticketDate(ticket.updated)],['Due date',ticketDate(ticket.due)]];
  if(ticket.labels)entries.push(['Labels',ticket.labels]);
  if(ticket.components)entries.push(['Components',ticket.components]);
  return entries.map(([label,entry])=>`<div><dt>${label}</dt><dd>${entry?esc(value(entry)):'&mdash;'}</dd></div>`).join('');
}
function attachmentSection(ticket,open){
  const files=Array.isArray(ticket.attachments)?ticket.attachments.filter(file=>/^\d+$/.test(file.id)):[];
  const available=Array.isArray(ticket.attachments);
  const sizeLabel=size=>size>=1048576?(size/1048576).toFixed(1)+' MB':size>=1024?Math.ceil(size/1024)+' KB':Math.max(0,size||0)+' B';
  const validKey=keyFrom(ticket.key)===ticket.key;
  const rows=files.map(file=>{
    const url='/api/ticket/'+encodeURIComponent(ticket.key)+'/attachments/'+file.id;
    return '<li><div class="attachment-info"><b>'+esc(file.filename)+'</b><small>'+esc(sizeLabel(file.size))+(file.author?' - '+esc(file.author):'')+'</small></div><div class="attachment-actions">'+(validKey?'<a href="'+url+'" target="_blank" rel="noopener noreferrer">Open</a><a href="'+url+'?download=1" target="_blank" rel="noopener noreferrer">Download</a>':'')+'</div></li>';
  }).join('');
  return '<details class="ticket-attachments" '+((open??files.length>0)?'open':'')+'><summary>Attachments'+(available?' ('+files.length+')':'')+'</summary>'+(rows?'<ul class="attachment-list">'+rows+'</ul>':available?'<p class="hint">No attached files.</p>':'<p class="hint">Refresh from Jira to load attached files.</p>')+'</details>';
}
function render(ticket) {
  if(ticketInputStage==='loading')setTicketInputState('idle');
  const sameTicket=currentTicket&&OpsWorkflow.draftKey(currentTicket)===OpsWorkflow.draftKey(ticket);
  if(!sameTicket)dismissTicketPanels();
  const keepAttachmentsOpen=sameTicket?$('#ticket').querySelector?.('.ticket-attachments')?.open:undefined;
  const keepDetailsOpen=sameTicket&&$('#ticket').querySelector?.('.ticket-more-details')?.open===true;
  ticketLoadVersion++;
  saveDraft();
  currentTicket = ticket;
  localStorage.setItem('lastTicket', JSON.stringify(ticket));
  $('#ticket').className = 'ticket-content';
  const jiraLink=/^https?:\/\//i.test(ticket.url||'')?`<a href="${esc(ticket.url)}" target="_blank" rel="noopener noreferrer">Open in Jira &nearr;</a>`:'';
  $('#ticket').innerHTML=`<div class="ticket-overview-header"><div class="ticket-identity"><span class="key">${esc(ticket.key)}</span><button type="button" class="ticket-status-badge" onclick="openTicketStatus()" aria-label="Change status: ${esc(ticket.status||'unavailable')}" ${keyFrom(ticket.key)===ticket.key?'':'disabled'}>${esc(ticket.status||'Status unavailable')}<span aria-hidden="true">&#x2304;</span></button></div><details class="ticket-actions"><summary aria-label="More ticket actions">More actions <span aria-hidden="true">&#x22EF;</span></summary><div class="ticket-action-menu">${jiraLink}<button type="button" onclick="openCoordinate('location')">Edit Jira coordinate fields</button><button type="button" onclick="copyBrief()">Copy brief</button><button type="button" onclick="refreshActiveTicket(true)">Refresh ticket</button></div></details></div><h2 class="ticketTitle">${esc(ticket.title||'Untitled')}</h2>${coordinateTiles(ticket)}<section class="ticket-problem" aria-label="Problem"><h3>Problem</h3><div class="description">${esc(ticket.description||'No description returned.')}</div></section>${attachmentSection(ticket,keepAttachmentsOpen)}<details class="ticket-more-details" ${keepDetailsOpen?'open':''}><summary>More details</summary><dl class="ticket-detail-list">${secondaryTicketDetails(ticket)}</dl></details>`;
  highlightTools(ticket);
  updateJiraControls();
  const draft = drafts[OpsWorkflow.draftKey(ticket)] || {};
  $('#customerReply').value = draft.customer || '';
  $('#notes').value = draft.work || '';
  for (const selector of ['#customerReply','#notes','#insertTemplate','#copyDraft']) $(selector).disabled = false;
  setMode(draft.mode === 'work' ? 'work' : 'customer');
  $('#draftStatus').textContent = 'Saved';
  $('#jiraInput').value = ticket.key === 'UNKEYED' ? '' : ticket.key || '';
  $('#raw').value = ticket.sourceText || '';
  const tabIndex = ticketTabs.findIndex(tab => OpsWorkflow.draftKey(tab.ticket) === OpsWorkflow.draftKey(ticket));
  if (tabIndex !== -1 && JSON.stringify(ticketTabs[tabIndex].ticket) !== JSON.stringify(ticket)) {
    const updated = ticketTabs.map((tab,index) => index === tabIndex ? {...tab,ticket} : tab);
    persistTicketTabs(updated);
  }
  renderTicketTabs();
  renderComments();
  if(ticket.url&&ticket.commentMode==='service')loadComments({refresh:true});
  scheduleSessionSave();
}
function setTicketInputState(stage,message='') {
  clearTimeout(ticketInputTimer);
  ticketInputStage=stage;
  const module=$('#importModule');
  for(const name of ['is-opening','is-opened','has-input-error'])module.classList.remove(name);
  if(stage==='loading')module.classList.add('is-opening');
  if(stage==='success'){void module.offsetWidth;module.classList.add('is-opened');}
  if(stage==='error')module.classList.add('has-input-error');
  module.setAttribute('aria-busy',String(stage==='loading'));
  $('#jiraInput').setAttribute('aria-invalid',String(stage==='error'));
  $('#importBtn').disabled=stage==='loading';
  $('#importBtn').textContent=stage==='loading'?'Opening':stage==='success'?'Opened':'Open';
  $('#ticketInputFeedback').textContent=stage==='error'?message:'';
  $('#ticketInputFeedback').hidden=stage!=='error';
  $('#ticketInputAnnouncement').textContent=stage==='loading'?'Loading ticket...':stage==='success'?message:'';
  if(stage==='success')ticketInputTimer=setTimeout(()=>{setTicketInputState('idle');$('#ticketModule').classList.remove('ticket-arrived');},1800);
}
function ticketOpened(label) {
  $('#pasteTicketDetails').open=false;
  setTicketInputState('success',label+' opened');
  const module=$('#ticketModule');module.classList.remove('ticket-arrived');void module.offsetWidth;module.classList.add('ticket-arrived');
}
async function importJira() {
  if(ticketInputStage==='loading')return;
  const input=$('#jiraInput').value;
  const key=keyFrom(input);
  if(!key){setTicketInputState('error','Enter a Jira ticket key or URL.');$('#jiraInput').focus();return;}
  const requestVersion=++ticketLoadVersion;
  setTicketInputState('loading');
  try {
    const payload=await jiraAPI('/api/ticket/'+encodeURIComponent(key));
    if(requestVersion!==ticketLoadVersion)return;
    const nextInput=$('#jiraInput').value;
    render(normalise(payload));
    if(nextInput!==input)$('#jiraInput').value=nextInput;
    ticketOpened(key);
    setState('Opened '+key);
    scheduleSessionSave();
  } catch(error) {
    if(requestVersion===ticketLoadVersion){setTicketInputState('error',error.message);setState(error.message,true);}
  }
}
function field(text, names) {
  for (const name of names) {
    const match = new RegExp('(?:^|\\n)\\s*' + name + '\\s*[:*]?\\s*(?:\\n\\s*)?([^\\n]+)', 'i').exec(text);
    if (match) return match[1].trim();
  }
  return '';
}
function parse() {
  const text = $('#raw').value.trim();
  if (!text) {setTicketInputState('error','Paste ticket text first.');return;}
  const lines = text.split('\n').map(line=>line.trim()).filter(Boolean);
  const description = /(?:^|\n)\s*(?:Statement of Work|Description)\s*[:*]?\s*\n?([\s\S]*?)(?=\n\s*(?:Status|Priority|Assignee|Reporter|Datacenter Location|Location|Cage\/Suite & Rack Number|Rack|Unit Height|Service Tag|Remote Hands Request Type|Request Type)\s*:|$)/i.exec(text)?.[1]?.trim();
  render({key:keyFrom(text)||'UNKEYED',title:field(text,['Summary','Title'])||lines[0],status:field(text,['Status']),priority:field(text,['Priority']),description:description||field(text,['Statement of Work','Description']),sourceText:text,location:field(text,['Datacenter Location','Location']),rack:field(text,['Cage/Suite & Rack Number','Rack']),unit:field(text,['Unit Height','Unit']),serviceTag:field(text,['Service Tag']),requestType:field(text,['Remote Hands Request Type','Request Type']),assignee:field(text,['Assignee']),reporter:field(text,['Reporter'])});
  ticketOpened(currentTicket.key==='UNKEYED'?'Pasted ticket':currentTicket.key);
  setState('Opened pasted ticket');
}
function setState(message, bad=false) {
  $('#state').textContent = message;
  $('#state').style.color = bad ? 'var(--red)' : 'var(--muted)';
}
function highlightTools(ticket=currentTicket) {
  const suggestions=ticket?OpsWorkflow.analyze(ticket).tools:[];
  const normalize=url=>String(url||'').replace(/\/$/,'');
  for(const link of document.querySelectorAll('aside a.tool')) {
    const match=suggestions.find(tool=>normalize(tool.url)===normalize(link.getAttribute('href')));
    link.classList.toggle('suggested',Boolean(match));
    link.setAttribute('title',match?'Suggested: '+match.reason:'Open '+link.textContent.trim());
    link.setAttribute('aria-description',match?match.reason:'');
  }
}
function renderTools() {
  $('#tools').innerHTML = store.tools.map((tool,index)=>`<div class="line"><a class="tool" style="flex:1" href="${esc(/^https?:\/\//i.test(tool.url) ? tool.url : '#')}" target="_blank" rel="noopener noreferrer">${esc(tool.icon)} ${esc(tool.name)}</a><button onclick="removeTool(${index})" aria-label="Remove ${esc(tool.name)}">&times;</button></div>`).join('');
  highlightTools();
}
function save() { localStorage.setItem('opsDeck', JSON.stringify(store)); scheduleSessionSave(); }
function setMode(nextMode) {
  mode = nextMode;
  const customer = mode === 'customer';
  $('#customerReply').hidden = !customer;
  $('#notes').hidden = customer;
  $('#customerMode').className = customer ? 'primary' : '';
  $('#workMode').className = customer ? '' : 'primary';
  $('#customerMode').setAttribute('aria-pressed', String(customer));
  $('#workMode').setAttribute('aria-pressed', String(!customer));
  $('#draftLabel').textContent = customer ? 'Customer reply draft' : 'Internal note draft';
  $('#draftVisibility').textContent=customer?'Public':'Internal';
  $('#draftVisibility').className='composer-visibility '+(customer?'customer':'work');
  $('#draftLabel').htmlFor = customer ? 'customerReply' : 'notes';
  $('#draftHint').textContent = customer ? 'Write a customer-facing update. Keep internal details in Work notes.' : 'Record internal findings, commands, actions taken, and next steps.';
  $('#copyDraft').textContent = customer ? 'Copy customer reply' : 'Copy work notes';
  updateJiraControls();
}
function saveDraft() {
  if (!currentTicket) return;
  drafts[OpsWorkflow.draftKey(currentTicket)] = {...drafts[OpsWorkflow.draftKey(currentTicket)],customer:$('#customerReply').value,work:$('#notes').value,mode};
  try {
    localStorage.setItem('opsDeckDrafts', JSON.stringify(drafts));
    $('#draftStatus').textContent = 'Saved';
  } catch { $('#draftStatus').textContent = 'Could not save locally. Copy your draft before leaving this page.'; }
  updateJiraControls();
  scheduleSessionSave();
}
async function copyText(text, label) {
  try { await navigator.clipboard.writeText(text); setState(label + ' copied'); }
  catch { setState('Clipboard unavailable. Select and copy the text manually.', true); }
}
window.removeTool = index => { store.tools.splice(index,1); save(); renderTools(); };
window.copyBrief = () => {
  if (!currentTicket) return;
  const menu=$('#ticket').querySelector?.('.ticket-actions');if(menu)menu.open=false;
  const ticket = {...currentTicket,...coordinateValues()};
  return copyText(`${ticket.key} - ${ticket.title}\n${ticket.description || ''}\nLocation: ${ticket.location || '?'} | ${ticket.rack || '?'} | ${ticket.unit || '?'}\nService tag: ${ticket.serviceTag || '?'}`, 'Brief');
};
$('#openTicketForm').onsubmit=event=>{event.preventDefault();return importJira();};
$('#jiraInput').addEventListener('input',()=>{if(ticketInputStage==='error'||ticketInputStage==='success')setTicketInputState('idle');});
$('#parseBtn').onclick = parse;
$('#customerMode').onclick = () => { setMode('customer'); saveDraft(); };
$('#workMode').onclick = () => { setMode('work'); saveDraft(); };
$('#customerReply').oninput = saveDraft;
$('#notes').oninput = saveDraft;
$('#insertTemplate').onclick = () => {
  if (!currentTicket) return;
  $('#composerMore').open=false;
  const editor = $(mode === 'customer' ? '#customerReply' : '#notes');
  if (editor.value.trim()) { $('#draftStatus').textContent = 'Your draft already contains text. Clear it first to insert a template.'; return; }
  editor.value = OpsWorkflow.template({...currentTicket,...coordinateValues()}, mode);
  saveDraft();
  editor.focus();
};
$('#copyDraft').onclick = () => {
  $('#composerMore').open=false;
  const text = $(mode === 'customer' ? '#customerReply' : '#notes').value;
  if (!text.trim()) return setState('Write a draft or insert a template first', true);
  return copyText(text, mode === 'customer' ? 'Customer reply' : 'Work notes');
};
$('#addTool').onclick = () => $('#toolDialog').showModal();
$('#saveTool').onclick = event => {
  event.preventDefault();
  const name = $('#toolName').value.trim(), url = $('#toolUrl').value.trim();
  if (!name || !/^https?:\/\//i.test(url)) return;
  store.tools.push({name,url,icon:$('#toolIcon').value});
  save(); renderTools(); $('#toolDialog').close();
};

function persistTicketTabs(nextTabs) {
  try {
    localStorage.setItem('aetherDeskTicketTabs', JSON.stringify(nextTabs));
    ticketTabs = nextTabs;
    scheduleSessionSave();
    return true;
  } catch {
    $('#tabStatus').textContent = 'Could not save tabs. Browser storage may be full. Copy your drafts before leaving.';
    return false;
  }
}
function renderTicketTabs() {
  const currentId = currentTicket ? OpsWorkflow.draftKey(currentTicket) : null;
  const active = ticketTabs.find(tab => OpsWorkflow.draftKey(tab.ticket) === currentId);
  $('#tabCount').textContent = String(ticketTabs.length);
  $('#tabLabel').disabled = !currentTicket;
  $('#saveTicketTab').disabled = !currentTicket;
  $('#tabLabel').value = active ? active.label : currentTicket ? [currentTicket.key === 'UNKEYED' ? '' : currentTicket.key,currentTicket.title].filter(Boolean).join(' - ').slice(0,80) : '';
  $('#saveTicketTab').textContent = active ? 'Update tab' : 'Save as tab';
  $('#savedTicketTabs').innerHTML = ticketTabs.length ? ticketTabs.map((tab,index) => {
    const selected = OpsWorkflow.draftKey(tab.ticket) === currentId;
    return `<div class="saved-ticket-row${selected ? ' selected' : ''}"><button type="button" class="ticket-tab" onclick="openTicketTab(${index})" aria-pressed="${selected}" title="${esc(tab.ticket.title || '')}"><span>${esc(tab.label)}</span><small>${esc(tab.ticket.key || 'Pasted ticket')}</small></button><button type="button" class="close-ticket-tab" onclick="closeTicketTab(${index})" aria-label="Remove tab ${esc(tab.label)}" title="Remove tab; keep drafts">&times;</button></div>`;
  }).join('') : '<p class="tabs-empty">Your saved tickets will appear here.</p>';
}
window.openTicketTab = index => {
  const tab = ticketTabs[index];
  if (!tab) return;
  render(tab.ticket);
  $('#tabStatus').textContent = 'Opened ' + tab.label + '. Drafts restored.';
  setState('Opened ' + (tab.ticket.key || 'ticket'));
  if(tab.ticket.url)refreshActiveTicket(false);
};
window.closeTicketTab = index => {
  if (!ticketTabs[index]) return;
  saveDraft();
  if (!persistTicketTabs(ticketTabs.filter((tab,position) => position !== index))) return;
  renderTicketTabs();
  $('#tabStatus').textContent = 'Tab removed. Your ticket and drafts are kept.';
  scheduleSessionSave();
};
$('#saveTabForm').onsubmit = event => {
  event.preventDefault();
  if (!currentTicket) return;
  const label = $('#tabLabel').value.trim().slice(0,80);
  if (!label) { $('#tabStatus').textContent = 'Choose a label for this tab.'; $('#tabLabel').focus(); return; }
  saveDraft();
  const id = OpsWorkflow.draftKey(currentTicket);
  const index = ticketTabs.findIndex(tab => OpsWorkflow.draftKey(tab.ticket) === id);
  const saved = {label,ticket:currentTicket};
  const nextTabs = index === -1 ? [...ticketTabs,saved] : ticketTabs.map((tab,position) => position === index ? saved : tab);
  if (!persistTicketTabs(nextTabs)) return;
  renderTicketTabs();
  $('#tabStatus').textContent = index === -1 ? 'Saved as ' + label + '.' : 'Updated ' + label + '.';
  scheduleSessionSave();
};
$('#newTicket').onclick = () => {
  setTicketInputState('idle');
  $('#ticketModule').classList.remove('ticket-arrived');
  ticketLoadVersion++;
  saveDraft();
  dismissTicketPanels();
  currentTicket = null;
  localStorage.removeItem('lastTicket');
  $('#ticket').className = 'ticket-content empty';
  $('#ticket').innerHTML = 'Load a ticket to begin.';
  highlightTools(null);
  renderComments();
  updateJiraControls();
  for (const selector of ['#customerReply','#notes','#jiraInput','#raw']) $(selector).value = '';
  for (const selector of ['#customerReply','#notes','#insertTemplate','#copyDraft']) $(selector).disabled = true;
  setMode('customer');
  $('#draftStatus').textContent = '';
  $('#tabStatus').textContent = 'Load another ticket, then save it with a label.';
  renderTicketTabs();
  setState('Ready for another ticket');
  layoutManager?.reveal('import');
  $('#jiraInput').focus();
  scheduleSessionSave();
};


const coordinateLabels={location:'Datacenter',rack:'Rack',unit:'Unit',serviceTag:'Service tag'};
let jiraSyncError='';
function coordinateValues(ticket=currentTicket) {
  if(!ticket)return {};
  const saved=drafts[OpsWorkflow.draftKey(ticket)]?.coordinates||{};
  return Object.fromEntries(Object.keys(coordinateLabels).map(key=>[key,Object.hasOwn(saved,key)?saved[key]:value(ticket[key])]));
}
function coordinateNoteBody(values) {
  return 'Work coordinates\n'+Object.entries(coordinateLabels).map(([key,label])=>label+': '+(String(values[key]||'').trim()||'(not set)')).join('\n');
}
function coordinateTiles(ticket) {
  const values=coordinateValues(ticket);
  const body=coordinateNoteBody(values);
  const sent=drafts[OpsWorkflow.draftKey(ticket)]?.coordinatePost?.body===body;
  const canPost=ticket.commentMode==='service'&&Object.values(values).some(entry=>String(entry).trim())&&!coordinateSnapshotPosting&&!sent;
  return '<div class="coordinate-tiles" role="group" aria-label="Work coordinates">'+Object.entries(coordinateLabels).map(([key,label])=>`<label class="coordinate-tile coordinate-paste-tile"><span class="coordinate-label">${label}</span><textarea data-coordinate="${key}" aria-label="${label}" rows="2" maxlength="1000" placeholder="Paste here" spellcheck="false">${esc(values[key])}</textarea></label>`).join('')+`</div><div class="coordinate-inline-actions"><button type="button" class="coordinate-post-all" onclick="postCoordinateSnapshot()" ${canPost?'':'disabled'}>${coordinateSnapshotPosting?'Posting...':'Post coordinates as work note'}</button><span class="coordinate-inline-status" role="status">${esc(coordinateFeedback.get(OpsWorkflow.draftKey(ticket))||(sent?'Coordinates posted.':'Saved in this desk'))}</span></div>`;
}
function updateCoordinateFeedback() {
  if(!currentTicket)return;
  const values=coordinateValues();const id=OpsWorkflow.draftKey(currentTicket);
  const button=$('#ticket').querySelector?.('.coordinate-post-all');
  const status=$('#ticket').querySelector?.('.coordinate-inline-status');
  const sent=drafts[id]?.coordinatePost?.body===coordinateNoteBody(values);
  if(button){button.disabled=currentTicket.commentMode!=='service'||coordinateSnapshotPosting||sent||!Object.values(values).some(entry=>String(entry).trim());button.textContent=coordinateSnapshotPosting?'Posting...':'Post coordinates as work note';}
  if(status)status.textContent=coordinateFeedback.get(id)||(sent?'Coordinates posted.':'Saved in this desk');
}
$('#ticket').addEventListener('input',event=>{
  const key=event.target.dataset?.coordinate;
  if(!currentTicket||!Object.hasOwn(coordinateLabels,key))return;
  const id=OpsWorkflow.draftKey(currentTicket);
  const draft=drafts[id]||{customer:'',work:''};
  draft.coordinates={...coordinateValues(),[key]:String(event.target.value).slice(0,1000)};
  drafts[id]=draft;coordinateFeedback.delete(id);
  saveDraft();updateCoordinateFeedback();
});
window.postCoordinateSnapshot=async()=>{
  if(!currentTicket||currentTicket.commentMode!=='service'||coordinateSnapshotPosting)return;
  const key=currentTicket.key,id=OpsWorkflow.draftKey(currentTicket),values=coordinateValues();
  const body=coordinateNoteBody(values);
  if(!Object.values(values).some(entry=>String(entry).trim())||drafts[id]?.coordinatePost?.body===body)return;
  saveDraft();coordinateSnapshotPosting=true;updateCoordinateFeedback();
  try{
    const receipt=await jiraAPI('/api/ticket/'+encodeURIComponent(key)+'/comments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({visibility:'work',body})});
    const draft=drafts[id]||{customer:'',work:''};draft.coordinatePost={body,id:receipt.id,created:receipt.created};drafts[id]=draft;
    coordinateFeedback.set(id,'All four coordinates posted as an internal work note.');
    try{localStorage.setItem('opsDeckDrafts',JSON.stringify(drafts));}catch{}
    scheduleSessionSave();
    if(currentTicket?.key===key)loadComments({refresh:true});
  }catch(error){coordinateFeedback.set(id,error.message);}
  finally{coordinateSnapshotPosting=false;updateCoordinateFeedback();}
};
function dismissTicketPanels() {
  if(!jiraPosting){pendingJiraPost=null;closeInlinePanel('#jiraPostDialog');}
  if(!coordinateSaving){coordinateEditor=null;closeInlinePanel('#coordinateDialog');}
  if(!statusSaving){statusEditor=null;closeInlinePanel('#statusDialog');}
}
function openInlinePanel(selector) {
  const panel=$(selector);panel.hidden=false;panel.open=true;panel.scrollIntoView?.({block:'nearest'});
}
function closeInlinePanel(selector) {const panel=$(selector);panel.hidden=true;panel.open=false;}

window.openTicketStatus=()=>{if(!$('#changeTicketStatus').disabled)return $('#changeTicketStatus').onclick();};
function updateJiraControls(){
  const validKey=currentTicket&&keyFrom(currentTicket.key)===currentTicket.key;
  const customer=mode==='customer';
  $('#refreshTicket').disabled=!validKey||jiraSyncBusy;
  $('#changeTicketStatus').disabled=!validKey||jiraSyncBusy||statusSaving;
  $('#addGreeting').hidden=!customer;
  $('#addGreeting').disabled=!currentTicket||!customer;
  const body=$(customer?'#customerReply':'#notes').value||'';
  const draft=currentTicket?drafts[OpsWorkflow.draftKey(currentTicket)]:null;
  const sent=draft?.sent?.[mode];
  const alreadySent=sent?.body===body;
  $('#postDraft').disabled=!validKey||currentTicket.commentMode!=='service'||!body.trim()||jiraPosting||alreadySent;
  $('#postDraft').textContent='Review & send';
  $('#postDraft').setAttribute('aria-label',customer?'Review and send public customer reply':'Review and send internal note');
  $('#jiraPostStatus').textContent=alreadySent?'Sent'+(sent.created?' '+new Date(sent.created).toLocaleTimeString():''):currentTicket&&currentTicket.commentMode!=='service'?'Refresh from Jira to enable sending.':'';
  $('#liveSyncStatus').textContent=jiraSyncBusy?'Refreshing from Jira...':jiraSyncError?jiraSyncError:currentTicket?.syncedAt?'Last synced '+new Date(currentTicket.syncedAt).toLocaleTimeString():'Local snapshot';
}
async function jiraAPI(url,options){
  let response;
  try{response=await fetch(url,options);}catch{
    const error=new Error(options?.method==='POST'?'Connection lost before confirmation. Check the Jira ticket before retrying; your draft is kept.':'Could not reach Jira. Your saved ticket and drafts are kept.');
    error.uncertain=options?.method==='POST';throw error;
  }
  const result=await response.json().catch(()=>({}));
  if(!response.ok){const restartNeeded=response.status===404&&!result.error;const error=new Error(result.error||(restartNeeded?'The running Aether Desk server needs restarting. Close its window and launch Start Aether Desk.cmd, then refresh.':'Jira request failed (HTTP '+response.status+').'));error.uncertain=result.uncertain===true;throw error;}
  return result;
}
async function refreshActiveTicket(manual=true){
  if(!currentTicket||jiraSyncBusy||jiraPosting||coordinateEditor||coordinateSaving||statusEditor||statusSaving)return;
  if(!manual&&(!$('#liveRefresh').checked||!currentTicket.url||document.activeElement?.dataset?.coordinate))return;
  const key=keyFrom(currentTicket.key);if(!key)return;
  const version=ticketLoadVersion;
  jiraSyncBusy=true;jiraSyncError='';updateJiraControls();
  try{
    const payload=await jiraAPI('/api/ticket/'+encodeURIComponent(key));
    if(!currentTicket||currentTicket.key!==key||ticketLoadVersion!==version)return;
    const inputs=Object.fromEntries(['jiraInput','raw','tabLabel'].map(name=>[name,$('#'+name).value]));
    render(normalise(payload));
    for(const [name,value]of Object.entries(inputs))$('#'+name).value=value;
    scheduleSessionSave();
    if(manual)setState('Refreshed '+key);
  }catch(error){if(currentTicket?.key===key){jiraSyncError='Refresh failed; showing saved data. '+error.message;if(manual)setState(error.message,true);}}
  finally{jiraSyncBusy=false;updateJiraControls();}
}
document.addEventListener('pointerdown',event=>{const menu=$('#ticket').querySelector?.('.ticket-actions');if(menu&&!menu.contains(event.target))menu.open=false;});
$('#refreshTicket').onclick=()=>refreshActiveTicket(true);
$('#liveRefresh').onchange=()=>{scheduleSessionSave();if($('#liveRefresh').checked)refreshActiveTicket(false);};
setInterval(()=>{if(document.visibilityState!=='hidden')refreshActiveTicket(false);},60000);
window.addEventListener('focus',()=>{if($('#liveRefresh').checked)refreshActiveTicket(false);});
$('#addGreeting').onclick=()=>{
  if(!currentTicket||mode!=='customer')return;
  $('#customerReply').value=OpsWorkflow.greeting(currentTicket,$('#customerReply').value);
  saveDraft();$('#customerReply').focus();
};
$('#postDraft').onclick=()=>{
  if(!currentTicket||currentTicket.commentMode!=='service'||jiraPosting)return;
  const body=$(mode==='customer'?'#customerReply':'#notes').value;
  if(!body.trim()||drafts[OpsWorkflow.draftKey(currentTicket)]?.sent?.[mode]?.body===body)return;
  saveDraft();
  pendingJiraPost={key:currentTicket.key,id:OpsWorkflow.draftKey(currentTicket),visibility:mode,body};
  $('#jiraPostTitle').textContent=(mode==='customer'?'Customer reply to ':'Internal work note on ')+currentTicket.key;
  $('#jiraPostAudience').textContent=mode==='customer'?'PUBLIC: visible to the customer in Jira.':'INTERNAL: visible to your service team, not the customer.';
  $('#jiraPostPreview').textContent=body;
  $('#jiraPostError').textContent='';
  $('#confirmJiraPost').textContent=mode==='customer'?'Post public reply':'Post internal note';
  $('#confirmJiraPost').disabled=false;
  openInlinePanel('#jiraPostDialog');
};
$('#cancelJiraPost').onclick=()=>{if(jiraPosting)return;pendingJiraPost=null;closeInlinePanel('#jiraPostDialog');};
$('#jiraPostDialog').addEventListener('cancel',event=>{if(jiraPosting)event.preventDefault();else pendingJiraPost=null;});
$('#confirmJiraPost').onclick=async()=>{
  if(!pendingJiraPost||jiraPosting)return;
  const submission={...pendingJiraPost};
  jiraPosting=true;$('#confirmJiraPost').disabled=true;$('#cancelJiraPost').disabled=true;updateJiraControls();
  try{
    const receipt=await jiraAPI('/api/ticket/'+encodeURIComponent(submission.key)+'/comments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({visibility:submission.visibility,body:submission.body})});
    const draft=drafts[submission.id]||{customer:'',work:''};
    draft.sent={...draft.sent,[submission.visibility]:{body:submission.body,id:receipt.id,created:receipt.created}};
    drafts[submission.id]=draft;
    try{localStorage.setItem('opsDeckDrafts',JSON.stringify(drafts));}catch{}
    pendingJiraPost=null;closeInlinePanel('#jiraPostDialog');scheduleSessionSave();
    if(currentTicket?.key===submission.key)loadComments({refresh:true});
    setState((submission.visibility==='customer'?'Customer reply':'Internal work note')+' posted to '+submission.key);
  }catch(error){
    $('#jiraPostError').textContent=error.message;
    // Keep the text and require checking Jira if the result was uncertain.
    $('#confirmJiraPost').disabled=error.uncertain===true;
  }finally{jiraPosting=false;$('#cancelJiraPost').disabled=false;updateJiraControls();}
};
function coordinateValue(){
  const field=coordinateEditor?.field;if(!field)return '';
  if(field.kind==='multi')return [...$('#coordinateSelect').selectedOptions].map(option=>option.value);
  return ['option'].includes(field.kind)?$('#coordinateSelect').value:$('#coordinateValue').value;
}
function coordinatePreview(){
  const addNote=$('#coordinateAddNote').checked===true;
  $('#coordinatePreview').hidden=!addNote;
  $('#confirmCoordinate').textContent=addNote?'Save coordinate + work note':'Save coordinate';
  if(!coordinateEditor?.field)return;
  const field=coordinateEditor.field,value=coordinateValue();
  const pretty=field.kind==='multi'?value.map(id=>field.options.find(option=>option.id===id)?.label||'').join(', '):field.kind==='option'?field.options.find(option=>option.id===value)?.label||'':String(value).trim();
  $('#coordinatePreview').textContent=addNote?'Internal work note: '+coordinateLabels[coordinateEditor.coordinate]+' coordinate changed to '+JSON.stringify(pretty||'(cleared)'):'';
}
window.openCoordinate=async coordinate=>{
  if(!currentTicket||!Object.hasOwn(coordinateLabels,coordinate)||coordinateSaving)return;
  const keepNote=Boolean(coordinateEditor?.key===currentTicket.key&&$('#coordinateDialog').open&&$('#coordinateAddNote').checked);
  const editor={key:currentTicket.key,id:OpsWorkflow.draftKey(currentTicket),coordinate,field:null};
  coordinateEditor=editor;
  $('#coordinateAddNote').checked=keepNote;
  $('#coordinateAddNote').disabled=false;
  coordinatePreview();
  $('#coordinateTarget').value=coordinate;
  $('#coordinateTarget').disabled=false;
  $('#coordinateTitle').textContent='Change '+coordinateLabels[coordinate]+' on '+editor.key;
  $('#coordinateSource').textContent='Loading editable Jira fields...';$('#coordinateError').textContent='';$('#coordinatePreview').textContent='';
  $('#coordinateValue').hidden=true;$('#coordinateSelect').hidden=true;$('#confirmCoordinate').disabled=true;
  if(!$('#coordinateDialog').open)openInlinePanel('#coordinateDialog');
  try{
    const result=await jiraAPI('/api/ticket/'+encodeURIComponent(editor.key)+'/coordinates');
    if(coordinateEditor!==editor)return;
    if(result.supportsOptionalWorkNote!==true)throw Error('Restart Aether Desk to enable optional work notes. No coordinate changes have been made.');
    if(result.commentMode!=='service')throw Error('This ticket does not support service-management coordinates.');
    editor.field=result.coordinates[coordinate];
    if(!editor.field)throw Error('Coordinate metadata unavailable.');
    const field=editor.field;
    $('#coordinateSource').textContent=field.source;
    const select=['option','multi'].includes(field.kind);
    $('#coordinateSelect').hidden=!select;$('#coordinateValue').hidden=select;
    $('#coordinateSelect').multiple=field.kind==='multi';
    $('#coordinateSelect').innerHTML=(field.kind==='option'&&!field.required?'<option value="">(clear)</option>':'')+(field.options||[]).map(option=>`<option value="${esc(option.id)}" ${(Array.isArray(field.value)?field.value.includes(option.id):field.value===option.id)?'selected':''}>${esc(option.label)}</option>`).join('');
    $('#coordinateValue').value=Array.isArray(field.value)?'':field.value||'';
    $('#coordinateHint').textContent=field.kind==='multi'?'Select the Jira locations to keep (Ctrl or Cmd selects more than one).':field.kind==='note'?'This value is saved as Aether Desk ticket data in Jira. It does not change a native custom field.':'Saving updates the named Jira field. The internal work note is optional.';
    $('#confirmCoordinate').disabled=false;coordinatePreview();
  }catch(error){if(coordinateEditor===editor)$('#coordinateError').textContent=error.message;}
};
$('#coordinateTarget').onchange=()=>window.openCoordinate($('#coordinateTarget').value);
$('#coordinateAddNote').onchange=coordinatePreview;
$('#coordinateValue').oninput=coordinatePreview;
$('#coordinateSelect').onchange=coordinatePreview;
$('#cancelCoordinate').onclick=()=>{if(coordinateSaving)return;coordinateEditor=null;closeInlinePanel('#coordinateDialog');};
$('#coordinateDialog').addEventListener('cancel',event=>{if(coordinateSaving)event.preventDefault();else coordinateEditor=null;});
$('#confirmCoordinate').onclick=async()=>{
  if(!coordinateEditor?.field||coordinateSaving)return;
  const editor=coordinateEditor;
  const addWorkNote=$('#coordinateAddNote').checked===true;
  $('#coordinateAddNote').disabled=true;
  coordinateSaving=true;$('#coordinateTarget').disabled=true;$('#confirmCoordinate').disabled=true;$('#cancelCoordinate').disabled=true;
  try{
    const result=await jiraAPI('/api/ticket/'+encodeURIComponent(editor.key)+'/coordinates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({coordinate:editor.coordinate,value:coordinateValue(),expectedValue:editor.field.value,addWorkNote})});
    if(addWorkNote&&result.changed&&!result.notePosted){
      const draft=drafts[editor.id]||{customer:'',work:''};
      if(result.note&&!draft.work.includes(result.note))draft.work+=(draft.work?'\n\n':'')+result.note;
      drafts[editor.id]=draft;
      if(currentTicket&&OpsWorkflow.draftKey(currentTicket)===editor.id)$('#notes').value=draft.work;
      try{localStorage.setItem('opsDeckDrafts',JSON.stringify(drafts));}catch{}
    }
    if(result.changed&&drafts[editor.id]?.coordinates)delete drafts[editor.id].coordinates[editor.coordinate];
    coordinateEditor=null;closeInlinePanel('#coordinateDialog');coordinateSaving=false;
    if(currentTicket?.key===editor.key)await refreshActiveTicket(true);
    $('#coordinateActionStatus').textContent=result.warning||(!result.changed?'Coordinate unchanged.':coordinateLabels[editor.coordinate]+(result.notePosted?' saved and internal work note posted.':' saved. No work note added.'));
    scheduleSessionSave();
  }catch(error){$('#coordinateError').textContent=error.message;$('#confirmCoordinate').disabled=error.uncertain===true;}
  finally{coordinateSaving=false;$('#coordinateAddNote').disabled=false;$('#coordinateTarget').disabled=false;$('#cancelCoordinate').disabled=false;updateJiraControls();}
};

const commentsCache=new Map();
function commentsEntry(key){
  if(!commentsCache.has(key))commentsCache.set(key,{items:null,nextStart:null,complete:false,loading:false,reload:false,error:''});
  return commentsCache.get(key);
}
function renderComments(){
  const ticket=currentTicket;
  const available=ticket?.commentMode==='service'&&Boolean(keyFrom(ticket.key));
  const entry=available?commentsEntry(ticket.key):null;
  $('#refreshComments').disabled=!available||entry.loading;
  $('#moreComments').hidden=!entry||entry.nextStart===null||!entry.historyExpanded;
  $('#moreComments').disabled=!entry||entry.loading;
  $('#toggleHistory').hidden=true;
  $('#conversationCount').textContent='0';
  $('#conversationHistory').classList.toggle('is-expanded',entry?.historyExpanded===true);
  if(!available){
    $('#commentsStatus').textContent=ticket?'Refresh from Jira to see activity.':'Load a ticket to see activity.';
    $('#commentsList').innerHTML='';return;
  }
  if(entry.items===null){
    $('#commentsList').innerHTML='';
    $('#commentsStatus').textContent=entry.error||(entry.loading?'Loading activity...':'Refresh to load activity.');return;
  }
  const filter=$('#commentFilter').value||'all';
  const matching=entry.items.filter(comment=>filter==='all'||comment.visibility===filter);
  const visible=entry.historyExpanded?matching:matching.slice(0,3);
  const expanded=entry.openComments||(entry.openComments=new Set());
  $('#conversationCount').textContent=String(matching.length)+(entry.nextStart===null?'':'+');
  $('#toggleHistory').hidden=matching.length<=3&&entry.nextStart===null;
  $('#toggleHistory').textContent=entry.historyExpanded?'Show recent':'View history'+(matching.length>3?' ('+matching.length+')':'');
  $('#toggleHistory').setAttribute('aria-expanded',String(entry.historyExpanded===true));
  $('#commentsList').innerHTML=visible.map(comment=>{
    const visibility=comment.visibility==='customer'?'Customer reply':comment.visibility==='work'?'Internal note':'Visibility unavailable';
    const date=Number.isFinite(Date.parse(comment.created))?new Date(comment.created).toLocaleString():'Date unavailable';
    const body=comment.body||'(Empty comment)';
    const compact=body.replace(/\s+/g,' ').trim();
    const preview=compact.length>140?compact.slice(0,137)+'...':compact;
    return '<details class="jira-comment" data-ticket-key="'+esc(ticket.key)+'" data-comment-id="'+esc(comment.id)+'"'+(expanded.has(String(comment.id))?' open':'')+'><summary><div class="comment-heading"><b>'+esc(comment.author)+'</b><span class="comment-visibility '+esc(comment.visibility)+'">'+visibility+'</span><span class="comment-expand" aria-hidden="true">&#x2304;</span></div><time datetime="'+esc(comment.created)+'">'+esc(date)+'</time><p class="comment-preview">'+esc(preview)+'</p></summary><div class="comment-body">'+esc(body)+'</div></details>';
  }).join('')||'<p class="muted conversation-empty">No activity in this view.</p>';
  $('#commentsStatus').textContent=entry.error?'Could not refresh. Showing previously loaded activity. '+entry.error:entry.loading?'Refreshing...':!entry.complete?'More Jira history is available.':'';
}
$('#commentsList').addEventListener('toggle',event=>{
  const detail=event.target;
  if(!detail.matches?.('.jira-comment')||detail.dataset.ticketKey!==currentTicket?.key)return;
  const entry=commentsEntry(currentTicket.key);
  const expanded=entry.openComments||(entry.openComments=new Set());
  if(detail.open)expanded.add(detail.dataset.commentId);else expanded.delete(detail.dataset.commentId);
},true);
$('#toggleHistory').onclick=()=>{
  if(!currentTicket||currentTicket.commentMode!=='service')return;
  const entry=commentsEntry(currentTicket.key);
  entry.historyExpanded=!entry.historyExpanded;
  renderComments();
};
async function loadComments({refresh=false}={}){
  if(!currentTicket||currentTicket.commentMode!=='service')return;
  const key=currentTicket.key;const entry=commentsEntry(key);
  if(entry.loading){if(refresh)entry.reload=true;return;}
  entry.loading=true;entry.error='';renderComments();
  try{
    const start=refresh?0:entry.nextStart||0;
    const result=await jiraAPI('/api/ticket/'+encodeURIComponent(key)+'/comments?start='+start);
    if(!Array.isArray(result.comments))throw Error('Jira returned an invalid comment list.');
    const unique=new Map((refresh?[]:entry.items||[]).map(comment=>[comment.id,comment]));
    for(const comment of result.comments)unique.set(comment.id,comment);
    entry.items=[...unique.values()].sort((a,b)=>(Date.parse(b.created)||0)-(Date.parse(a.created)||0));
    entry.nextStart=typeof result.nextStart==='number'?result.nextStart:null;
    entry.complete=result.complete===true;
  }catch(error){entry.error=error.message;}
  finally{
    entry.loading=false;
    if(currentTicket?.key===key){renderComments();if(entry.reload){entry.reload=false;loadComments({refresh:true});}}
    else entry.reload=false;
  }
}
$('#refreshComments').onclick=()=>loadComments({refresh:true});
$('#moreComments').onclick=()=>loadComments();
$('#commentFilter').onchange=()=>{renderComments();scheduleSessionSave();};
$('#changeTicketStatus').onclick=async()=>{
  if(!currentTicket||statusSaving)return;
  const editor={key:currentTicket.key,status:'',transitions:[]};statusEditor=editor;
  $('#statusDialogTitle').textContent='Change status of '+editor.key;
  $('#currentStatusText').textContent='Loading current Jira workflow...';$('#statusError').textContent='';$('#statusTransitionHint').textContent='';
  $('#statusTransition').innerHTML='<option value="">Loading...</option>';$('#statusTransition').disabled=true;$('#confirmStatusChange').disabled=true;
  openInlinePanel('#statusDialog');
  try{
    const result=await jiraAPI('/api/ticket/'+encodeURIComponent(editor.key)+'/transitions');
    if(statusEditor!==editor)return;
    editor.status=result.status;editor.transitions=result.transitions||[];
    $('#currentStatusText').textContent='Current Jira status: '+editor.status;
    $('#statusTransition').innerHTML='<option value="">Choose a status change...</option>'+editor.transitions.map(transition=>`<option value="${esc(transition.id)}">${esc(transition.status)} - ${esc(transition.name)}</option>`).join('');
    $('#statusTransition').value='';$('#statusTransition').disabled=!editor.transitions.length;
    $('#statusTransitionHint').textContent=editor.transitions.length?'Only actions allowed by your Jira workflow are listed.':'Jira reports no available status transitions for your account.';
  }catch(error){if(statusEditor===editor)$('#statusError').textContent=error.message;}
};
$('#statusTransition').onchange=()=>{
  const transition=statusEditor?.transitions.find(item=>item.id===$('#statusTransition').value);
  const required=transition?.requiredFields||[];
  $('#confirmStatusChange').disabled=!transition||required.length>0||statusSaving;
  $('#statusError').textContent='';
  $('#statusTransitionHint').textContent=!transition?'Choose an available Jira action.':required.length?'This action requires '+required.map(field=>field.name).join(', ')+'. Use Open in Jira to complete it.':'Confirm change from '+statusEditor.status+' to '+transition.status+'.';
};
$('#cancelStatusChange').onclick=()=>{if(statusSaving)return;statusEditor=null;closeInlinePanel('#statusDialog');};
$('#statusDialog').addEventListener('cancel',event=>{if(statusSaving)event.preventDefault();else statusEditor=null;});
$('#confirmStatusChange').onclick=async()=>{
  if(!statusEditor||statusSaving)return;
  const editor=statusEditor;const transition=editor.transitions.find(item=>item.id===$('#statusTransition').value);
  if(!transition||(transition.requiredFields||[]).length)return;
  saveDraft();statusSaving=true;$('#confirmStatusChange').disabled=true;$('#cancelStatusChange').disabled=true;updateJiraControls();
  try{
    const result=await jiraAPI('/api/ticket/'+encodeURIComponent(editor.key)+'/transitions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transitionId:transition.id,expectedStatus:editor.status})});
    statusEditor=null;statusSaving=false;closeInlinePanel('#statusDialog');
    if(currentTicket?.key===editor.key)await refreshActiveTicket(true);
    $('#statusActionStatus').textContent='Jira accepted the status change to '+result.status+'.';
    setState('Status updated on '+editor.key);scheduleSessionSave();
  }catch(error){$('#statusError').textContent=error.message;$('#confirmStatusChange').disabled=error.uncertain===true;}
  finally{statusSaving=false;$('#cancelStatusChange').disabled=false;updateJiraControls();}
};
function captureSession() {
  return AetherSession.validate({version:1,savedAt:new Date().toISOString(),tabs:ticketTabs,drafts,tools:store.tools,currentTicket,mode,autoRefresh:$('#liveRefresh').checked!==false,layout:layoutManager?layoutManager.snapshot():deskLayout,inputs:{jiraInput:$('#jiraInput').value,raw:$('#raw').value,tabLabel:$('#tabLabel').value,commentFilter:$('#commentFilter').value||'all'}});
}
function scheduleSessionSave() {
  if(!sessionReady)return;
  try {
    pendingSession=captureSession();
    localStorage.setItem('aetherDeskSession',JSON.stringify(pendingSession));
    $('#sessionStatus').textContent='Saved in browser. Saving on this computer...';
  } catch(error) {
    $('#sessionStatus').textContent='Session save needs attention: '+error.message;
    return;
  }
  clearTimeout(sessionTimer);
  sessionTimer=setTimeout(flushSessionSave,750);
}
let sessionSavePromise=Promise.resolve(true);
async function flushSessionSave() {
  clearTimeout(sessionTimer);
  if(sessionSaving){await sessionSavePromise;return pendingSession?flushSessionSave():true;}
  if(!pendingSession)return true;
  const snapshot=pendingSession;
  pendingSession=null;
  sessionSaving=true;
  sessionSavePromise=(async()=>{
    let success=false;
    try {
      const response=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot)});
      if(!response.ok)throw Error('Disk save unavailable');
      if(!pendingSession)$('#sessionStatus').textContent='Saved on this computer at '+new Date(snapshot.savedAt).toLocaleTimeString();
      success=true;
      return true;
    } catch {
      pendingSession=pendingSession||snapshot;
      $('#sessionStatus').textContent='Saved in browser only. Restart Aether Desk if needed, then choose Save now or export a backup.';
      return false;
    } finally {
      sessionSaving=false;
      if(success&&pendingSession)sessionTimer=setTimeout(flushSessionSave,250);
    }
  })();
  return sessionSavePromise;
}
function applySession(input) {
  const snapshot=AetherSession.validate(input);
  const wasReady=sessionReady;
  sessionReady=false;
  ticketLoadVersion++;
  currentTicket=null;
  ticketTabs=snapshot.tabs;
  drafts=snapshot.drafts;
  store.tools=snapshot.tools;
  $('#commentFilter').value=snapshot.inputs.commentFilter||'all';
  $('#liveRefresh').checked=snapshot.autoRefresh!==false;
  deskLayout=snapshot.layout||{};
  if(layoutManager)layoutManager.restore(deskLayout);
  if(snapshot.currentTicket)render(snapshot.currentTicket);
  else {
    $('#ticket').className='ticket-content empty';$('#ticket').innerHTML='Load a ticket to begin.';
    highlightTools(null);
  renderComments();
    updateJiraControls();
    for(const selector of ['#customerReply','#notes'])$(selector).value='';
    for(const selector of ['#customerReply','#notes','#insertTemplate','#copyDraft'])$(selector).disabled=true;
    renderTicketTabs();
  }
  setMode(snapshot.mode);
  for(const name of ['jiraInput','raw','tabLabel'])$('#'+name).value=snapshot.inputs[name];
  try {
    localStorage.setItem('opsDeck',JSON.stringify(store));
    localStorage.setItem('opsDeckDrafts',JSON.stringify(drafts));
    localStorage.setItem('aetherDeskTicketTabs',JSON.stringify(ticketTabs));
    localStorage.setItem('aetherDeskSession',JSON.stringify(snapshot));
    if(currentTicket)localStorage.setItem('lastTicket',JSON.stringify(currentTicket));else localStorage.removeItem('lastTicket');
  } catch { $('#sessionStatus').textContent='Browser storage is unavailable. Export a backup after working.'; }
  renderTools();
  sessionReady=wasReady;
}
async function initializeSession() {
  const layout=document.querySelector('.layout');
  layout.inert=true;
  let cached=null;
  try{const candidate=readJSON('aetherDeskSession',null);if(candidate)cached=AetherSession.validate(candidate);}catch{}
  const hasLegacy=currentTicket||ticketTabs.length||Object.keys(drafts).length||store.tools.length;
  if(!cached&&hasLegacy)cached=captureSession();
  if(cached)applySession(cached);
  let disk=null;
  let recovered=false;
  let unavailable=false;
  try {
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),5000);
    try {
      const response=await fetch('/api/session',{cache:'no-store',signal:controller.signal});
      if(!response.ok)throw Error('Session recovery unavailable');
      const data=await response.json();
      disk=data.session?AetherSession.validate(data.session):null;
      recovered=data.recovered===true;
    } finally {clearTimeout(timeout);}
  } catch {unavailable=true;}
  try {
    if(disk&&(!cached||Date.parse(disk.savedAt)>Date.parse(cached.savedAt))){applySession(disk);cached=disk;}
    sessionReady=true;
    layout.inert=false;
    $('#sessionStatus').textContent=unavailable?'Browser session restored. Restart Aether Desk to enable saving on this computer.':recovered?'Session recovered from the previous disk save.':'Session restored. Changes save automatically.';
    // Mirror migrated browser data, recovered data, or a newer browser save to disk.
    if(!disk||(cached&&Date.parse(cached.savedAt)>Date.parse(disk.savedAt))||recovered){
      scheduleSessionSave();
      if(!unavailable)await flushSessionSave();
    }
  } finally {sessionReady=true;layout.inert=false;}
}
$('#saveSessionNow').onclick=async()=>{saveDraft();scheduleSessionSave();await flushSessionSave();};
$('#exportSession').onclick=()=>{
  try {
    saveDraft();
    const snapshot=captureSession();
    const blob=new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');link.href=url;link.download='aether-desk-session-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
    document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    $('#sessionStatus').textContent='Backup exported. Your automatic session saving remains active.';
  } catch(error){$('#sessionStatus').textContent='Could not export backup: '+error.message;}
};
$('#importSession').onclick=()=>$('#sessionFile').click();
$('#sessionFile').onchange=async()=>{
  const file=$('#sessionFile').files[0];if(!file)return;
  try {
    if(file.size>AetherSession.MAX_BYTES)throw Error('Backup exceeds 5 MB.');
    pendingRestore=AetherSession.validate(JSON.parse(await file.text()));
    $('#restoreSessionSummary').textContent='This backup contains '+pendingRestore.tabs.length+' saved tabs and '+Object.keys(pendingRestore.drafts).length+' ticket drafts, saved '+new Date(pendingRestore.savedAt).toLocaleString()+'.';
    $('#restoreSessionDialog').showModal();
  } catch(error){pendingRestore=null;$('#sessionStatus').textContent='Backup was not restored: '+error.message;}
  finally{$('#sessionFile').value='';}
};
$('#cancelRestore').onclick=()=>{pendingRestore=null;$('#restoreSessionDialog').close();};
$('#confirmRestore').onclick=async()=>{
  if(!pendingRestore)return;
  $('#confirmRestore').disabled=true;
  try {
    saveDraft();scheduleSessionSave();
    if(!await flushSessionSave())throw Error('Save your current session on this computer before restoring. You can also export a backup.');
    localStorage.setItem('aetherDeskSessionBeforeRestore',JSON.stringify(captureSession()));
    const snapshot=pendingRestore;pendingRestore=null;
    applySession(snapshot);scheduleSessionSave();
    $('#restoreSessionDialog').close();
    await flushSessionSave();
  } catch(error){$('#sessionStatus').textContent=error.message;}
  finally{$('#confirmRestore').disabled=false;}
};
for(const name of ['jiraInput','raw','tabLabel'])$('#'+name).addEventListener('input',scheduleSessionSave);
window.addEventListener('pagehide',()=>{if(pendingSession)flushSessionSave();});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&pendingSession)flushSessionSave();});
window.addEventListener('online',()=>{if(pendingSession)flushSessionSave();});
setInterval(()=>{if(pendingSession&&!sessionSaving)flushSessionSave();},30000);
let ticketTabsCollapsed=readJSON('aetherDeskTabsCollapsed',false)===true;
function applyTicketTabsPanel(){
  document.querySelector('.layout').classList?.toggle('ticket-tabs-collapsed',ticketTabsCollapsed);
  $('#ticketTabsPanel').classList.toggle('is-collapsed',ticketTabsCollapsed);
  $('#ticketTabsContent').hidden=ticketTabsCollapsed;
  $('#tabsTitle').hidden=ticketTabsCollapsed;
  $('#tabCount').hidden=ticketTabsCollapsed;
  const toggle=$('#toggleTicketTabs');
  toggle.textContent=ticketTabsCollapsed?'\u2039':'\u203a';
  toggle.setAttribute('aria-expanded',String(!ticketTabsCollapsed));
  toggle.setAttribute('aria-label',ticketTabsCollapsed?'Show ticket tabs':'Collapse ticket tabs');
  toggle.title=ticketTabsCollapsed?'Show ticket tabs':'Collapse ticket tabs';
  layoutManager?.reflow();
}
$('#toggleTicketTabs').onclick=()=>{
  ticketTabsCollapsed=!ticketTabsCollapsed;
  try{localStorage.setItem('aetherDeskTabsCollapsed',JSON.stringify(ticketTabsCollapsed));}catch{}
  applyTicketTabsPanel();
};
applyTicketTabsPanel();
renderTools();save();renderTicketTabs();
const last=readJSON('lastTicket',null);
if(last)render(last);
layoutManager=AetherLayout.create({
  canvas:$('#deskCanvas'),
  modules:[{id:'import',name:'Open ticket',element:$('#importModule'),handle:$('#importHandle'),toggle:$('#minimizeImport')},{id:'ticket',name:'Ticket details',element:$('#ticketModule'),handle:$('#ticketHandle'),toggle:$('#minimizeTicket')},{id:'draft',name:'Conversation',element:$('#draftModule'),handle:$('#draftHandle'),toggle:$('#minimizeDraft')}],
  layout:deskLayout,
  onChange:layout=>{
    deskLayout=layout;
    try{localStorage.setItem('aetherDeskLayout',JSON.stringify(layout));}catch{}
    scheduleSessionSave();
  }
});
let ticketCaptureBusy=false;
$('#captureTicket').onclick=async()=>{
  if(ticketCaptureBusy)return;
  ticketCaptureBusy=true;
  const key=keyFrom(currentTicket?.key)||'ticket-details';
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  try{
    const panel=$('#ticketModule');
    const bounds=panel.getBoundingClientRect();
    setState('Saving Ticket details screenshot...');
    if(typeof html2canvas!=='function')throw Error('Screenshot library did not load. Refresh Aether Desk and try again.');
    const canvas=await html2canvas(panel,{
      backgroundColor:'#171b23',logging:false,
      scale:Math.min(window.devicePixelRatio||1,2),
      width:Math.ceil(bounds.width),height:Math.ceil(bounds.height)
    });
    const blob=await new Promise((resolve,reject)=>canvas.toBlob(result=>result?resolve(result):reject(Error('Could not create the PNG file.')),'image/png'));
    const response=await fetch('/api/screenshots?key='+encodeURIComponent(key),{method:'POST',headers:{'Content-Type':'image/png'},body:blob});
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw Error(result.error||'Could not save the screenshot. Restart Aether Desk and try again.');
    setState('Screenshot saved: '+result.path);

  }catch(error){setState('Screenshot failed: '+error.message,true);}
  finally{ticketCaptureBusy=false;}
};
$('#showImportModule').onclick=()=>layoutManager.reveal('import');
$('#showTicketModule').onclick=()=>layoutManager.reveal('ticket');
$('#showDraftModule').onclick=()=>layoutManager.reveal('draft');
$('#resetDeskLayout').onclick=()=>layoutManager.reset();
AetherQueue.create({document,request:jiraAPI,setInterval,onAssigned:async key=>{if(currentTicket?.key===key)await refreshActiveTicket(false);},openTicket:async key=>{
  saveDraft();
  $('#jiraInput').value=key;
  await importJira();
  const opened=currentTicket?.key===key&&ticketInputStage==='success';
  if(opened)layoutManager.reveal('ticket');
  return opened;
}});
initializeSession().then(()=>{if(currentTicket?.url)refreshActiveTicket(false);}).catch(error=>{sessionReady=true;document.querySelector('.layout').inert=false;$('#sessionStatus').textContent='Could not fully restore session: '+error.message;});
