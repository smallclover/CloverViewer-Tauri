const assert=require("node:assert/strict");
const test=require("node:test");
const loadTs=require("./helpers/load-ts.cjs");
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test("failed settings and startup writes restore the actual controls and never report success",async()=>{
  const elements=new Map(),notices=[],languages=[];let writes=0;
  let config={language:"Zh",theme:"dark",ui_scale:100,zoom_sensitivity:1,image_preview_strip_enabled:true,
    hotkeys:{show_screenshot:"Alt+S",copy_color:"Alt+C",scroll_capture:"Alt+Shift+S"},
    magnifier_enabled:true,desktop_pet_scale:100,launch_on_startup:false};
  const element=id=>{if(!elements.has(id)) {const handlers=new Map();const node={value:"",dataset:{},classList:{add(){},remove(){},toggle(){},contains:()=>false},setAttribute(){},addEventListener:(name,handler)=>handlers.set(name,handler),fire:name=>handlers.get(name)?.({})};elements.set(id,node);}return elements.get(id);};
  const {createSettingsController}=loadTs("ui/settings-controller.ts",{
    "../api":{setConfig:async()=>{writes++;throw Error("denied");},setLaunchOnStartup:async()=>{throw Error("registry denied");},getCacheSummary:async()=>({files:0,bytes:0}),formatSize:()=>"0"},
    "./select-control":{createSelectControl:()=>({refresh(){},close(){}})},
    "./update-controller":{createUpdateController:()=>({run(){},isBusy(){return false;},dismiss(){}})},
    "./update-status-view":{createUpdateStatusView:()=>({render(){}})},
    "./presentation":{playEnterAnimation(){},setAnimatedVisibility(){}},
  },{document:{getElementById:element,querySelectorAll:()=>[]}});
  const controller=createSettingsController({getConfig:()=>config,setCurrentConfig:next=>{config=next;},setLanguage:value=>languages.push(value),applyTheme(){},applyI18n(){},refreshViewerTranslations(){},refreshImagePreviewStrip(){},refreshActiveHotkeys:async()=>{},setDesktopPetEnabled:async()=>{},translate:key=>key,toast:(_,kind)=>notices.push(kind)});
  controller.open();element("set-language").value="En";element("set-language").fire("change");await flush();
  assert.equal(config.language,"Zh");assert.equal(element("set-language").value,"Zh");assert.deepEqual(languages,["En","Zh"]);
  element("set-autostart").checked=true;element("set-autostart").fire("change");await flush();
  assert.equal(element("set-autostart").checked,false);assert.equal(config.launch_on_startup,false);assert.equal(writes,1);
  assert.equal(notices.includes("success"),false);
});
