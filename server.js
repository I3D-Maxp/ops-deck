require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const path = require('path');
const app = express();
app.use(express.json({limit:'5mb'}));
const sessionStore=require('./session-store').createSessionStore(path.join(__dirname,'.data'));
app.use('/api/session',(req,res,next)=>{
  res.set('Cache-Control','no-store');
  if(!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(req.get('host')||''))return res.status(403).json({error:'Use the local Aether Desk address.'});
  const origin=req.get('origin');
  if(origin&&origin!==`http://${req.get('host')}`)return res.status(403).json({error:'Session access is limited to this local app.'});
  next();
});
app.get('/api/session',(req,res)=>{
  try{res.json(sessionStore.read());}catch{res.status(500).json({error:'Could not read the saved session. Your files have been kept.'});}
});
app.post('/api/session',(req,res)=>{
  let session;
  try{session=require('./public/session-format').validate(req.body);}catch(error){return res.status(400).json({error:error.message});}
  try{sessionStore.write(session);res.json({savedAt:session.savedAt});}catch{res.status(500).json({error:'Could not save the session on this computer. Check disk space and folder permissions.'});}
});
app.use('/api/screenshots',require('./screenshot-routes').createScreenshotRouter());
app.get('/api/health', (req,res) => res.json({app:'ops-deck-jira'}));
app.use('/animations',express.static(path.join(__dirname,'animations'),{index:false,dotfiles:'deny'}));
app.use(express.static(path.join(__dirname,'public')));
app.use('/api/ticket',require('./jira-routes').createJiraRouter());
const server = app.listen(process.env.PORT||3000, '127.0.0.1', ()=>console.log(`Aether Desk: http://localhost:${process.env.PORT||3000}`));
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? 'Aether Desk could not start: the configured port is already in use.' : `Aether Desk could not start: ${error.message}`);
  process.exit(1);
});
module.exports = server;
