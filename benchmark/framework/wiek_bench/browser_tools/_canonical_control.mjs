// Shared control-plane primitives for BOTH browsers. No host-specific fallback.
// Keep the factory self-contained: the smoke runner serializes it into SDK nodejs.
export function createBenchmarkV2({listTaskSpaces,taskSpace}) {
  if(typeof listTaskSpaces!=='function'||typeof taskSpace!=='function')throw new Error('Canonical SDK V2 unavailable');
  async function existing(candidates) {
    const spaces=await listTaskSpaces();
    if(!Array.isArray(spaces))throw new Error('Invalid task-space inventory');
    for(const candidate of candidates){
      const match=typeof candidate==='number'
        ? spaces.find(s=>s.id===candidate)
        : spaces.find(s=>s.name===candidate)||spaces.find(s=>String(s.id)===candidate);
      if(!match)continue;
      if(match.ownership!=='agent')throw new Error(`Task space ${match.id} is not Agent-owned`);
      // A numeric id never creates a missing named space. Native control checks
      // still apply if ownership changes after the inventory read.
      return {descriptor:match,task:await taskSpace(match.id)};
    }
    return null;
  }
  async function capture(candidates,params={format:'png'},{viewport=null}={}) {
    const selected=await existing(candidates);
    if(!selected)throw new Error('Benchmark task space not found');
    const tabs=await selected.task.tabs();
    const active=tabs.filter(tab=>tab.active);
    if(active.length!==1)throw new Error('Expected exactly one active benchmark tab');
    const page=active[0].page;
    if(!page||typeof page.cdp!=='function')throw new Error('Active benchmark tab is unmanaged; capture refused');
    let overridden=false;
    try {
      if(viewport){
        if(!Number.isInteger(viewport.width)||!Number.isInteger(viewport.height)||viewport.width<1||viewport.height<1||viewport.width>8192||viewport.height>8192||viewport.deviceScaleFactor!==1||viewport.mobile!==false)throw new Error('Invalid benchmark viewport');
        await page.cdp('Emulation.setDeviceMetricsOverride',viewport);overridden=true;
      }
      const image=await page.cdp('Page.captureScreenshot',params);
      if(!image||typeof image.data!=='string'||!image.data)throw new Error('Empty screenshot data');
      let ax=null,axError=null;
      try{ax=await page.cdp('Accessibility.getFullAXTree',{});}catch(error){axError=String(error.message||error);}
      return {spaceId:selected.descriptor.id,targetId:active[0].targetId,data:image.data,ax,axError,viewport};
    } finally {
      // An uncleared override contaminates later observations. Surface that
      // failure instead of accepting a capture with unknown page state.
      if(overridden)await page.cdp('Emulation.clearDeviceMetricsOverride',{});
    }
  }
  async function close(candidates) {
    const results=[];
    for(const candidate of candidates){
      try{
        const selected=await existing([candidate]);
        if(!selected){results.push({candidate,ok:true,notFound:true});continue;}
        const receipt=await selected.task.finish({keep:[]});
        // Protected pages can leave the space open. Preserve that outcome;
        // never force-claim or bypass the canonical retention policy.
        results.push({candidate,ok:receipt.closedSpace===true,receipt});
      }catch(error){results.push({candidate,ok:false,error:String(error.message||error)});}
    }
    return results;
  }
  return {existing,capture,close};
}
