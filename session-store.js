const fs=require('fs');
const path=require('path');
const {validate,MAX_BYTES}=require('./public/session-format');
function createSessionStore(directory){
  const current=path.join(directory,'session.json');
  const previous=path.join(directory,'session.previous.json');
  function readFile(file){
    if(fs.statSync(file).size>MAX_BYTES)throw Error('Session file is too large.');
    return validate(JSON.parse(fs.readFileSync(file,'utf8')));
  }
  function read(){
    let damaged=false;
    for(const file of [current,previous]){
      if(!fs.existsSync(file))continue;
      try{return {session:readFile(file),recovered:file===previous};}catch{damaged=true;}
    }
    if(damaged)throw Error('Saved session files could not be read. Restore an exported backup.');
    return {session:null,recovered:false};
  }
  function atomicWrite(file,text){
    const temporary=file+'.tmp';
    const fd=fs.openSync(temporary,'w');
    try{fs.writeFileSync(fd,text,'utf8');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temporary,file);
  }
  function write(input){
    const session=validate(input);
    fs.mkdirSync(directory,{recursive:true});
    if(fs.existsSync(current)){
      let validCurrent;
      try{validCurrent=readFile(current);}catch{}
      if(validCurrent)atomicWrite(previous,JSON.stringify(validCurrent));
    }
    atomicWrite(current,JSON.stringify(session));
    return session;
  }
  return {read,write};
}
module.exports={createSessionStore};
