require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();
app.use(express.json({limit:'1mb'}));
app.use(express.static(path.join(__dirname,'public')));
const keyFrom = v => ((String(v||'').match(/\b[A-Z][A-Z0-9]+-\d+\b/i)||[])[0]||'').toUpperCase();
app.get('/api/ticket/:input', async (req,res) => {
  const key=keyFrom(decodeURIComponent(req.params.input));
  if(!key) return res.status(400).json({error:'No Jira ticket key found.'});
  const {JIRA_BASE_URL,JIRA_EMAIL,JIRA_API_TOKEN}=process.env;
  if(!JIRA_BASE_URL||!JIRA_EMAIL||!JIRA_API_TOKEN) return res.status(500).json({error:'Jira is not configured. Copy .env.example to .env and add your credentials.'});
  try {
    const fields='summary,status,priority,description,issuetype,assignee,reporter,created,updated,duedate,labels,components,comment,*all';
    const r=await fetch(`${JIRA_BASE_URL.replace(/\/$/,'')}/rest/api/3/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(fields)}`,{headers:{Authorization:'Basic '+Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64'),Accept:'application/json'}});
    const body=await r.json().catch(()=>({}));
    if(!r.ok) return res.status(r.status).json({error:body.errorMessages?.join(' ')||body.message||`Jira returned ${r.status}`});
    res.json({baseUrl:JIRA_BASE_URL,issue:body});
  } catch(e){res.status(502).json({error:'Could not reach Jira: '+e.message});}
});
app.listen(process.env.PORT||3000,()=>console.log(`Ops Deck: http://localhost:${process.env.PORT||3000}`));
