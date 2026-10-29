const express=require('express');
const {createJiraClient}=require('./jira-client');
function createJiraRouter({client=createJiraClient()}={}){
  const router=express.Router();
  router.use((req,res,next)=>{
    res.set('Cache-Control','no-store');
    if(!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(req.get('host')||''))return res.status(403).json({error:'Use the local Aether Desk address.'});
    const origin=req.get('origin');
    if(origin&&origin!==`http://${req.get('host')}`)return res.status(403).json({error:'Jira access is limited to this local app.'});
    next();
  });
  router.param('key',(req,res,next,key)=>{
    if(!/^[A-Z][A-Z0-9]+-\d+$/i.test(key))return res.status(400).json({error:'No valid Jira ticket key found.'});
    req.ticketKey=key.toUpperCase();next();
  });
  const handle=action=>async(req,res)=>{try{res.json(await action(req));}catch(error){res.status(error.status||502).json({error:error.message,uncertain:error.uncertain===true});}};
  router.get('/queue',handle(req=>client.getQueue({cursor:req.query.cursor||'',filterId:req.query.filterId||'',queue:req.query.queue||'unassigned'})));
  router.get('/:key',handle(req=>client.read(req.ticketKey)));
  router.get('/:key/coordinates',handle(async req=>{const data=await client.read(req.ticketKey,{editing:true});return {key:req.ticketKey,coordinates:data.coordinates,commentMode:data.commentMode,supportsOptionalWorkNote:true};}));
  router.get('/:key/comments',handle(req=>client.getComments(req.ticketKey,{start:Number(req.query.start||0)})));
  router.get('/:key/attachments/:attachmentId',async(req,res)=>{
    const controller=new AbortController();
    res.on('close',()=>controller.abort());
    try{
      const {attachment,response}=await client.getAttachment(req.ticketKey,req.params.attachmentId,{signal:controller.signal});
      const safeInline=new Set(['image/png','image/jpeg','image/gif','image/webp','image/avif','application/pdf','text/plain']);
      const mime=String(attachment.mimeType||'').toLowerCase();
      const inline=req.query.download!=='1'&&safeInline.has(mime);
      res.attachment(String(attachment.filename||'attachment').replace(/[\r\n\0]/g,''));
      if(inline)res.set('Content-Disposition',res.get('Content-Disposition').replace(/^attachment/,'inline'));
      res.set('Content-Type',inline?mime:'application/octet-stream');
      res.set('X-Content-Type-Options','nosniff');
      res.set('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
      const {Readable}=require('node:stream');
      const {pipeline}=require('node:stream/promises');
      await pipeline(Readable.fromWeb(response.body),res);
    }catch(error){
      if(!res.headersSent&&!res.destroyed)res.status(error.status||502).json({error:error.message});
      else if(!res.destroyed)res.destroy();
    }
  });
  router.get('/:key/transitions',handle(req=>client.getTransitions(req.ticketKey)));
  router.post('/:key/assign-to-me',handle(req=>client.assignToMe(req.ticketKey)));
  router.post('/:key/transitions',handle(req=>client.changeStatus(req.ticketKey,req.body||{})));
  router.post('/:key/comments',handle(req=>client.postComment(req.ticketKey,req.body||{})));
  router.post('/:key/coordinates',handle(req=>client.changeCoordinate(req.ticketKey,req.body||{})));
  return router;
}
module.exports={createJiraRouter};
