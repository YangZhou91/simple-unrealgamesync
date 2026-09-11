const {chromium}=require('@playwright/test');
const {pathToFileURL}=require('url');
const path=require('path');
(async()=>{
 const browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1056,height:1050}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{
  class PreviewTweak{constructor(options){this.options=options;globalThis.previewControls=this;}addSelect(state,key){this.state=state;}addSlider(state,key){this.state=state;}addToggle(state,key){this.state=state;}}
  Object.defineProperty(globalThis,'Tweak',{configurable:true,get:()=>PreviewTweak,set:()=>{}});
 });
 await page.emulateMedia({colorScheme:'dark'});
 await page.goto(pathToFileURL(path.join(__dirname,'ugs-code-preview-check.html')).href);
 const frame=page.frames().find(f=>f!==page.mainFrame());
 const el=id=>frame.locator('#'+id);
 await el('ugs-code').waitFor();
 const capture=async name=>{await el('uc-toast').evaluate(e=>e.hidden=true);return el('ugs-code').screenshot({path:path.join(__dirname,'ugs-code-'+name+'.png')});};
 const assert=async(condition,message)=>{if(!await condition)throw new Error(message);};
 const state=async values=>frame.evaluate(v=>{Object.assign(globalThis.previewControls.state,v);globalThis.previewControls.options.onChange();},values);
 await capture('idle');
 await el('uc-target-cl').fill('wrong');await assert(el('uc-start-sync').isDisabled(),'CL validation');
 await el('uc-target-cl').fill('381700');await assert(el('uc-engine-option').isVisible(),'Engine opt-in missing');await assert(el('uc-sync-engine').isChecked().then(x=>!x),'Engine should default off');
 await el('uc-sync-engine').check();await assert(el('uc-engine-hint').textContent().then(x=>x==='同步项目 + UnrealEngine'),'Engine hint');
 await capture('target');
 await el('uc-start-sync').click();await assert(el('uc-running-view').isVisible(),'Running view');await assert(el('uc-open-settings').isDisabled(),'Settings not locked');
 await capture('running');
 await el('uc-tab-history').click();await assert(el('uc-open-rollback').isDisabled(),'Rollback not locked');
 await el('uc-tab-sync').click();await el('uc-cancel-sync').click();await assert(el('uc-cancel-sync').isDisabled(),'Cancel pending not disabled');
 await el('uc-idle-view').waitFor({state:'visible'});
 await state({view:'network-error'});await assert(el('uc-retry-sync').textContent().then(x=>x==='重新开始同步'),'Network retry semantics');
 await state({view:'git-error'});await assert(el('uc-git-action').textContent().then(x=>x==='返回空闲'),'Git error action');
 await state({view:'idle'});await el('uc-target-cl').fill('');
 await el('uc-tab-history').click();await capture('history');await el('uc-open-rollback').click();await assert(el('uc-rollback-next').isDisabled(),'No CL selected');
 await frame.locator('[data-cl="381204"]').click();await el('uc-rollback-next').click();await assert(el('uc-cl-confirmation').isVisible(),'No confirmation');await capture('rollback');await el('uc-rollback-next').click();
 await el('uc-tab-health').click();await assert(el('uc-health-report').isHidden(),'Health should be on demand');await el('uc-audit').click();await el('uc-health-report').waitFor({state:'visible'});await capture('health');
 await el('uc-open-settings').click();await capture('settings');await el('uc-settings-app-tab').click();await el('uc-proxy-enabled').check();await assert(el('uc-proxy-url').isEnabled(),'Proxy controls');await capture('app-settings');await page.keyboard.press('Escape');
 await el('uc-add-workspace').click();await capture('add');await page.keyboard.press('Escape');
 const layouts=[];
 const measure=async label=>{
  const metrics=await el('ugs-code').evaluate(root=>{const rr=root.getBoundingClientRect();const outside=[...root.querySelectorAll('*')].filter(e=>{const closed=e.closest('details:not([open])');if(closed&&e!==closed&&!e.closest('summary'))return false;const r=e.getBoundingClientRect();return r.width>0&&(r.left<rr.left-1||r.right>rr.right+1||r.bottom>rr.bottom+1);}).map(e=>e.id||e.className).slice(0,10);return{width:rr.width,height:rr.height,outside};});
  layouts.push({label,...metrics});
 };
 for(const theme of ['dark','light']){
  await page.emulateMedia({colorScheme:theme});
  for(const width of [1056,768,392,352]){
   await page.setViewportSize({width,height:1300});
   for(const view of ['idle','running','completed','error','git-running','git-error']){await state({view});await measure(theme+' '+width+' '+view);}
   await state({view:'idle'});
   for(const tab of ['history','health']){await el('uc-tab-'+tab).click();await measure(theme+' '+width+' '+tab);}
   await el('uc-open-settings').click();await measure(theme+' '+width+' settings');await page.keyboard.press('Escape');
   if(theme==='light'&&width===1056){await state({view:'idle'});await capture('light');}
   if(theme==='dark'&&width===392){await state({view:'idle'});await capture('narrow');}
  }
 }
 console.log(JSON.stringify({errors,interactions:'passed',issues:layouts.filter(x=>x.outside.length),desktop:layouts.find(x=>x.label==='dark 1056 idle'),checked:layouts.length},null,2));
 await browser.close();
})().catch(error=>{console.error(error);process.exit(1);});
