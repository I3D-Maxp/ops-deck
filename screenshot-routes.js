const express=require('express');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
function createScreenshotRouter({directory=path.join(__dirname,'Screenshots')}={}){
  const router=express.Router();
  router.use((req,res,next)=>{
    res.set('Cache-Control','no-store');
    const host=req.get('host')||'';
    if(!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host))return res.status(403).json({error:'Use the local Aether Desk address.'});
    const origin=req.get('origin');
    if(origin&&origin!=='http://'+host)return res.status(403).json({error:'Screenshot saving is limited to this local app.'});
    next();
  });
  router.post('/',express.raw({type:'image/png',limit:'20mb'}),async(req,res)=>{
    const key=req.query.key||'ticket-details';
    if(typeof key!=='string'||!/^([A-Z][A-Z0-9]+-\d+|ticket-details)$/.test(key))return res.status(400).json({error:'Invalid ticket key for this screenshot.'});
    const png=req.body;
    if(!Buffer.isBuffer(png)||png.length<45||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||png.toString('ascii',12,16)!=='IHDR'||png.toString('ascii',png.length-8,png.length-4)!=='IEND')return res.status(400).json({error:'A valid PNG screenshot is required.'});
    const width=png.readUInt32BE(16),height=png.readUInt32BE(20);
    if(!width||!height||width>30000||height>30000)return res.status(400).json({error:'Invalid screenshot dimensions.'});
    const filename=key+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8)+'.png';
    const target=path.join(directory,filename);
    try{
      await fs.mkdir(directory,{recursive:true});
      await fs.writeFile(target,png,{flag:'wx'});
      res.status(201).json({filename,path:target});
    }catch{res.status(500).json({error:'Could not save the screenshot in the Screenshots folder. Check disk space and folder permissions.'});}
  });
  router.use((error,req,res,next)=>{
    if(error.type==='entity.too.large')return res.status(413).json({error:'Screenshot exceeds the 20 MB limit.'});
    next(error);
  });
  return router;
}
module.exports={createScreenshotRouter};