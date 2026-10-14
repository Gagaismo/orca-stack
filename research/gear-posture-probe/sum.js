const fs=require('fs');const f=process.argv[2];const from=process.argv[3]||'';
let on=!from;
for(const l of fs.readFileSync(f,'utf8').split('\n')){ if(!l.trim())continue; let r; try{r=JSON.parse(l)}catch{console.log('  [broken line]');continue}
 if(r.ev==='run'){ if(r.label===from) on=true; if(on) console.log('== RUN',r.label,r.how,'mode='+r.mode,'gear='+r.gear); continue }
 if(!on) continue;
 if(r.ev==='compose') console.log('  compose traits',r.traits.join(','),'n',r.ids.length,'tail',r.ids.slice(-2).join(' | '),'ultra',r.ultraIds.join(','));
 else if(r.ev==='step') console.log('  step idx',r.index,'msgs',r.messageCount,'eff',r.effort,'cr',r.usage&&r.usage.cache_read_input_tokens,'cc',r.usage&&r.usage.cache_creation_input_tokens,'sid',r.sid.slice(0,8),'state',r.stateGear,'store',r.storeGear);
 else if(r.ev==='start') console.log('  start sid',r.sid.slice(0,8),'state',r.stateGear,'settings',JSON.stringify(r.settingsHits),'input',JSON.stringify(r.input).slice(0,160));
 else if(r.ev==='attach') console.log('  attach',r.type,r.len,r.ultra?'ULTRA':'',(r.head||'').replace(/\s+/g,' ').slice(0,90));
 else if(r.ev==='context') console.log('  context',r.names.join(' '));
 else console.log(' ',r.ev,JSON.stringify(r).slice(0,260));
}
