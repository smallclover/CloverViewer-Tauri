// Real browser QA of the integrated editor. Native API calls use an isolated in-memory store.
const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");
process.chdir(path.resolve(__dirname,".."));fs.mkdirSync(".unit-test-dist",{recursive:true});
const ts=require("../node_modules/typescript");
const {chromium}=require(process.env.CLOVER_PLAYWRIGHT_MODULE||"playwright");
const modules=[...['image-editor','image-beautify'].flatMap(dir=>fs.readdirSync('src/'+dir).filter(n=>n.endsWith('.ts')).map(n=>dir+'/'+n.slice(0,-3))),
 'viewer/image-editor-controller','viewer/image-editor-loader','ui/icons','ui/select-control','locales/zh-CN','locales/en','locales/ja'];
const code=Object.fromEntries(modules.map(name=>[name,ts.transpileModule(fs.readFileSync('src/'+name+'.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText]));
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:850}});page.setDefaultTimeout(6000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const css=['base','image-editor','image-crop','floating-ui','select','image-beautify'].map(n=>fs.readFileSync('src/styles/'+n+'.css','utf8')).join('\n');
  await page.route('http://localhost:4179/**',r=>r.fulfill({contentType:'text/html',body:`<style>${css}body{margin:0}#app{width:100vw;height:100vh;border:0;border-radius:0}#image-editor-view{height:100%}</style><div id="app"><div id="image-editor-view" class="hidden"></div></div>`}));
  await page.goto('http://localhost:4179/');
  const photo='data:image/webp;base64,'+fs.readFileSync('site/assets/alpine-lake.webp').toString('base64');
  await page.evaluate(async({code,photo})=>{
   const cache={};window.library={schema:3,revision:0,autoApply:false,defaultPresetId:'mac-light',lastPresetId:'mac-light',presets:[]};window.writes=[];window.notices=[];
   const logo=document.createElement('canvas');logo.width=64;logo.height=32;const logoCtx=logo.getContext('2d');logoCtx.fillStyle='#166534';logoCtx.fillRect(0,0,64,32);window.logo=logo.toDataURL();
   window.api={getBeautifyLibrary:async()=>structuredClone(window.library),saveBeautifyLibrary:async(next,expected)=>{if(expected!==library.revision)throw 'beautify.conflict';window.library={...structuredClone(next),revision:expected+1};return structuredClone(library);},readBeautifyAsset:async id=>{if(!id||id==='missing')throw 'beautify.missingAsset';return window.logo;},importBeautifyAsset:async()=>'logo'};
   const load=name=>{if(cache[name])return cache[name];if(!code[name])throw Error('Missing QA module '+name);const out={};cache[name]=out;new Function('exports','require',code[name])(out,dep=>{
    if(dep==='../api')return window.api;if(dep==='@tauri-apps/plugin-dialog')return {open:async()=>'logo.png',save:async()=>'result.png'};
    const parts=name.split('/').slice(0,-1);for(const p of dep.split('/'))if(p==='..')parts.pop();else if(p!=='.')parts.push(p);return load(parts.join('/'));});return out;};window.load=load;
   window.dictionary=load('locales/zh-CN').zh;window.t=(key,vars={})=>Object.entries(vars).reduce((s,[k,v])=>s.replaceAll('{'+k+'}',String(v)),dictionary[key]??key);
   window.editor=load('viewer/image-editor-controller').createImageEditorController({root:document.getElementById('image-editor-view'),getEditableSource:async()=>photo,saveImage:async(...args)=>writes.push(args),translate:window.t,onClose(){},onSaved(){},toast:(...args)=>notices.push(args)});
   window.entry={path:'photo.png',name:'photo.png',width:800,height:500};
   document.documentElement.dataset.theme='light';await editor.open(entry,()=>{});
  },{code,photo});

  const inspector=page.locator('.image-editor-inspector');
  const enabled=()=>inspector.getByLabel('启用美化',{exact:true});
  const tab=async name=>inspector.getByRole('button',{name,exact:true}).click();
  const frame=async name=>{await tab('样式');await inspector.getByRole('button',{name:'全部',exact:true}).click();await inspector.getByRole('button',{name,exact:true}).click();};
  const open=async()=>{await page.locator('[data-key="beautify.title"]').click();await inspector.waitFor({state:'visible'});};
  const fresh=async()=>{await page.evaluate(async()=>editor.open(entry,()=>{}));await open();};
  const compare=page.locator('.beautify-compare');
  const image=()=>page.locator('.image-editor-beauty-preview').evaluate(c=>c.toDataURL());
  const waitPaint=async()=>page.waitForTimeout(110);
  await open();assert(await inspector.getByRole('button',{name:'还原本次',exact:true}).isDisabled());
  for(const name of ['Mac 浅色窗口','Mac 深色窗口','黑框画廊','浅木装裱'])await frame(name);
  await tab('水印');await inspector.getByRole('button',{name:'添加文字',exact:true}).click();
  await inspector.getByRole('textbox',{name:'水印文字',exact:true}).fill('Round watermark');
  await inspector.getByRole('textbox',{name:'水印文字',exact:true}).fill('Final collection');
  // The shortcut has the same whole-round meaning even inside a text field.
  await page.keyboard.press('Control+z');assert.equal(await enabled().isChecked(),false);
  assert(await page.locator('[data-key="editor.undo"]').isDisabled());
  await enabled().focus();await page.keyboard.press('Control+Shift+z');
  assert.equal(await enabled().isChecked(),true);assert.equal(await inspector.getByRole('textbox',{name:'水印文字',exact:true}).inputValue(),'Final collection');
  await waitPaint();const before=await image();
  await inspector.getByRole('textbox',{name:'水印文字',exact:true}).fill('Updated collection');await waitPaint();const after=await image();assert.notEqual(before,after);
  const box=await compare.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  assert.equal(await compare.getAttribute('aria-pressed'),'true');await waitPaint();assert.equal(await image(),before);
  await page.screenshot({path:'.unit-test-dist/beautify-round-comparing.png'});
  await page.mouse.move(10,10);await page.mouse.up();await waitPaint();assert.equal(await image(),after);
  assert.equal(await inspector.getByRole('textbox',{name:'水印文字',exact:true}).inputValue(),'Updated collection');
  await compare.focus();await page.keyboard.down('Space');assert.equal(await compare.getAttribute('aria-pressed'),'true');
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.keyboard.up('Space');await waitPaint();
  assert.equal(await compare.getAttribute('aria-pressed'),'false');assert.equal(await image(),after);
  await inspector.getByRole('button',{name:'还原本次',exact:true}).click();
  assert.equal(await inspector.getByRole('textbox',{name:'水印文字',exact:true}).inputValue(),'Final collection');
  assert(await compare.isDisabled());
  await page.locator('[data-key="editor.undo"]').click();assert.equal(await enabled().isChecked(),false);assert(await page.locator('[data-key="editor.undo"]').isDisabled());
  await page.locator('[data-key="editor.redo"]').click();
  // Pointer cancellation restores just the in-progress watermark move, keeping the round's other edits.
  await inspector.getByRole('textbox',{name:'水印文字',exact:true}).fill('Keep this title');
  await tab('水印');await inspector.getByRole('button',{name:'添加文字',exact:true}).click();
  await inspector.getByRole('button',{name:'居中',exact:true}).click();await waitPaint();
  const originalOffset=await page.locator('.beautify-watermark-outline').boundingBox();
  const outline=await page.locator('.beautify-watermark-outline').boundingBox();
  await page.mouse.move(outline.x+outline.width/2,outline.y+outline.height/2);await page.mouse.down();await page.mouse.move(outline.x+outline.width/2+36,outline.y+outline.height/2+12);
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.mouse.up();
  await waitPaint();const restored=await page.locator('.beautify-watermark-outline').boundingBox();assert(Math.abs(restored.x-originalOffset.x)<1);assert(Math.abs(restored.y-originalOffset.y)<1);
  assert.equal(await inspector.locator('.beautify-layer').count(),1);
  await tab('水印');assert.equal(await inspector.getByRole('textbox',{name:'水印文字',exact:true}).inputValue(),'Keep this title');
  await inspector.getByRole('button',{name:'还原本次',exact:true}).click();
  // Real image operation order: annotation -> one beauty round -> annotation.
  await fresh();await inspector.getByRole('button',{name:'完成美化',exact:true}).click();
  const draw=async()=>{await page.locator('[data-key="shot.rect"]').click();const c=await page.locator('.image-editor-canvas').boundingBox();await page.mouse.move(c.x+c.width*.15,c.y+c.height*.15);await page.mouse.down();await page.mouse.move(c.x+c.width*.35,c.y+c.height*.35);await page.mouse.up();};
  await draw();await open();for(const name of ['Mac 浅色窗口','浅木装裱','黑框画廊'])await frame(name);
  await inspector.getByRole('button',{name:'完成美化',exact:true}).click();await draw();
  await page.locator('[data-key="editor.undo"]').click();await open();assert.equal(await enabled().isChecked(),true);
  await page.locator('[data-key="editor.undo"]').click();assert.equal(await enabled().isChecked(),false);
  assert.equal(await page.locator('[data-key="editor.undo"]').isDisabled(),false);
  await page.locator('[data-key="editor.undo"]').click();assert.equal(await page.locator('[data-key="editor.undo"]').isDisabled(),true);
  for(let i=0;i<3;i++)await page.locator('[data-key="editor.redo"]').click();assert.equal(await enabled().isChecked(),true);
  const selected=()=>inspector.locator('.beautify-preset-card.primary').innerText();assert.equal(await selected(),'黑框画廊');
  await frame('浅木装裱');await waitPaint();
  const expected=(await page.locator('.beautify-inspector-status').innerText()).match(/(\d+) × (\d+)/).slice(1).map(Number);
  // Saving while comparing must restore the live view and export the actual result.
  await compare.focus();await page.keyboard.down('Space');assert.equal(await compare.getAttribute('aria-pressed'),'true');
  await page.locator('[data-key="editor.saveOptions"]').evaluate(el=>el.click());await page.locator('[data-key="editor.saveAs"]').evaluate(el=>el.click());
  await page.waitForFunction(()=>writes.length===1);await page.keyboard.up('Space');
  const output=await page.evaluate(async()=>{const i=new Image();i.src=writes[0][1];await i.decode();return [i.naturalWidth,i.naturalHeight];});assert.deepEqual(output,expected);
  assert.equal(await compare.getAttribute('aria-pressed'),'false');assert(await compare.isDisabled());
  await frame('极简浏览器');await page.locator('[data-key="editor.undo"]').click();assert.equal(await selected(),'浅木装裱');
  await page.locator('[data-key="editor.undo"]').click();assert.equal(await selected(),'黑框画廊');
  // No edit, reverted edit and exact round-trip edits must not trigger exit protection.
  for(const scenario of ['empty','revert','round-trip']){
   await fresh();
   if(scenario!=='empty'){
    await frame('Mac 浅色窗口');await inspector.getByRole('button',{name:'完成美化',exact:true}).click();await open();
    if(scenario==='revert'){await frame('浅木装裱');await inspector.getByRole('button',{name:'还原本次',exact:true}).click();assert.equal(await selected(),'Mac 浅色窗口');}
    else {await frame('浅木装裱');await frame('Mac 浅色窗口');assert(await compare.isDisabled());}
    // Existing completed beauty still counts as unsaved; return to the initial image via Undo.
    await page.locator('[data-key="editor.undo"]').click();
    // Undo's pre-existing dirty-revision semantics intentionally differ from reverting an uncommitted round.
    await fresh();await frame('浅木装裱');await inspector.getByRole('button',{name:'还原本次',exact:true}).click();
   }
   await inspector.getByRole('button',{name:'完成美化',exact:true}).click();await page.locator('[data-key="editor.cancel"]').click();
   assert.equal(await page.locator('.image-editor-confirm-overlay').isVisible(),false);assert(await page.locator('#image-editor-view').evaluate(el=>el.classList.contains('hidden')));
  }
  await fresh();await frame('浅木装裱');await waitPaint();await page.screenshot({path:'.unit-test-dist/beautify-round-editor.png'});
  for(const [name,key]of [['en','en'],['ja','ja'],['zh-CN','zh']]){
   await page.evaluate(({name,key})=>{window.dictionary=load('locales/'+name)[key];editor.refreshTranslations();},{name,key});
   await page.screenshot({path:'.unit-test-dist/beautify-round-'+name+'.png'});
  }
  assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>notices.filter(n=>n[1]==='error')),[]);
  console.log('Beauty round browser QA passed: one-step history, text-field shortcuts, restore, hold/release/blur comparison, drag cancellation, interleaved annotations, save boundary and all locales.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
