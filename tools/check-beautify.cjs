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
  await page.locator('[data-key="shot.pen"]').click();
  await page.locator('[data-key="beautify.title"]').click();await inspector.waitFor({state:'visible'});
  assert.equal(await page.locator('[data-key="shot.pen"]').getAttribute('aria-pressed'),'false');
  assert.equal(await page.locator('dialog[open]').count(),0);
  await inspector.getByRole('button',{name:'Mac 浅色窗口',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.image-editor-beauty-preview').hidden);
  assert.equal(await inspector.getByLabel('启用美化',{exact:true}).isChecked(),true);
  await page.waitForTimeout(160);
  await page.screenshot({path:'.unit-test-dist/beautify-integrated-light.png'});
  const fit=await page.evaluate(()=>({surface:document.querySelector('.image-editor-surface').getBoundingClientRect().toJSON(),preview:document.querySelector('.image-editor-beauty-preview').getBoundingClientRect().toJSON()}));
  assert(fit.preview.left>=fit.surface.left&&fit.preview.right<=fit.surface.right+1);
  assert(fit.preview.top>=fit.surface.top&&fit.preview.bottom<=fit.surface.bottom+1);
  // Styles and quick adjustments share a page; detailed frame and poster controls are gone.
  assert.equal(await inspector.locator('.beautify-tabs > button').allTextContents().then(v=>v.join(',')), '样式,水印');
  await page.waitForFunction(()=>[...document.querySelectorAll('.beautify-preset-image canvas')].every(c=>c.width>1));
  assert.equal(await inspector.locator('.beautify-preset-image canvas').count(),4);
  assert.equal(await inspector.getByRole('spinbutton').count(),0);
  assert.equal(await inspector.getByRole('combobox').count(),0);
  const originalSize=await inspector.locator('.beautify-inspector-status').innerText();
  await inspector.getByRole('group',{name:'留白',exact:true}).getByRole('button',{name:'大',exact:true}).click();
  await page.waitForFunction(original=>document.querySelector('.beautify-inspector-status').textContent!==original,originalSize);
  await inspector.getByRole('button',{name:'透明背景',exact:true}).click();
  await inspector.getByRole('button',{name:'粉紫',exact:true}).click();
  await inspector.getByRole('button',{name:'照片装裱',exact:true}).click();
  assert.equal(await inspector.locator('.beautify-preset-card').count(),3);
  await inspector.getByRole('button',{name:'浅木装裱',exact:true}).click();
  assert.equal(await inspector.getByRole('spinbutton').count(),0);
  await page.screenshot({path:'.unit-test-dist/beautify-wood-controls.png'});
  await inspector.getByRole('button',{name:'拍立得纸框',exact:true}).click();
  await inspector.getByRole('button',{name:'透明背景',exact:true}).click();
  await page.screenshot({path:'.unit-test-dist/beautify-paper-controls.png'});
  await inspector.getByRole('button',{name:'截图展示',exact:true}).click();
  await inspector.getByRole('button',{name:'Mac 浅色窗口',exact:true}).click();
  await inspector.getByRole('button',{name:'水印',exact:true}).click();
  await inspector.getByRole('button',{name:'添加文字',exact:true}).click();
  await inspector.getByRole('textbox',{name:'水印文字'}).fill('© Clover Studio {date}');
  await inspector.getByRole('button',{name:'居中',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.beautify-watermark-outline').hidden);
  const outline=await page.locator('.beautify-watermark-outline').boundingBox();
  await page.mouse.move(outline.x+outline.width/2,outline.y+outline.height/2);await page.mouse.down();await page.mouse.move(outline.x+outline.width/2+35,outline.y+outline.height/2+15);await page.mouse.up();
  await page.waitForTimeout(120);
  const moved=await page.locator('.beautify-watermark-outline').boundingBox();
  assert(moved.x>outline.x+10);
  assert.equal(await inspector.getByRole('spinbutton').count(),2);
  await inspector.getByRole('button',{name:'添加文字',exact:true}).click();
  assert.equal(await inspector.locator('.beautify-layer').count(),1);
  await page.screenshot({path:'.unit-test-dist/beautify-integrated-watermark.png'});
  await inspector.getByRole('button',{name:'添加 Logo',exact:true}).click();
  await inspector.getByRole('button',{name:'导入 / 替换 PNG Logo…',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.beautify-inspector-status').classList.contains('error'));
  await inspector.getByRole('button',{name:'样式',exact:true}).click();
  await inspector.getByText('保存与管理个人预设',{exact:true}).click();
  await inspector.getByLabel('个人预设名称').fill('我的品牌模板');await inspector.getByRole('button',{name:'保存新预设',exact:true}).click();
  await page.waitForFunction(()=>library.presets.length===1);
  await inspector.getByText('预设与自动应用设置',{exact:true}).click();await inspector.getByLabel('新截图自动应用').check();
  await page.waitForFunction(()=>library.autoApply);
  await inspector.getByRole('button',{name:'收起美化面板',exact:true}).click();
  assert.equal(await inspector.isVisible(),false);assert.equal(await page.locator('.image-editor-beauty-preview').isVisible(),true);
  // Existing annotations stay interactive while the composition is displayed in the same viewport.
  await page.locator('[data-key="shot.rect"]').click();
  const canvas=await page.locator('.image-editor-canvas').boundingBox();
  await page.mouse.move(canvas.x+canvas.width*.2,canvas.y+canvas.height*.2);await page.mouse.down();await page.mouse.move(canvas.x+canvas.width*.55,canvas.y+canvas.height*.5);await page.mouse.up();
  await page.locator('[data-key="editor.saveOptions"]').click();await page.locator('[data-key="editor.saveAs"]').click();
  await page.waitForFunction(()=>writes.length===1);
  const output=await page.evaluate(async()=>{const image=new Image();image.src=writes[0][1];await image.decode();return {w:image.naturalWidth,h:image.naturalHeight,errors:notices.filter(n=>n[1]==='error')};});
  assert(output.w>800&&output.h>500);assert.deepEqual(output.errors,[]);
  // Undoing annotations does not discard decoration; hiding the inspector does not discard either.
  await page.locator('[data-key="editor.undo"]').click();await page.locator('[data-key="beautify.title"]').click();
  await inspector.waitFor({state:'visible'});await inspector.getByRole('button',{name:'样式',exact:true}).click();
  for(const [name,key]of [['en','en'],['ja','ja'],['zh-CN','zh']]){
   await page.evaluate(({name,key})=>{window.dictionary=load('locales/'+name)[key];editor.refreshTranslations();},{name,key});
   await page.screenshot({path:'.unit-test-dist/beautify-integrated-'+name+'.png'});
  }
  await page.setViewportSize({width:680,height:700});await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  await page.waitForTimeout(50);await page.screenshot({path:'.unit-test-dist/beautify-integrated-narrow-dark.png'});
  const narrow=await page.evaluate(()=>({pane:document.querySelector('.image-editor-inspector').getBoundingClientRect().toJSON(),canvas:document.querySelector('.image-editor-surface').getBoundingClientRect().toJSON()}));
  assert(narrow.pane.right<=680);assert(narrow.canvas.width>200);
  await page.keyboard.press('Escape');assert.equal(await inspector.isVisible(),false);assert.equal(await page.locator('#image-editor-view').isVisible(),true);
  assert.deepEqual(errors,[]);console.log('Integrated editor browser QA passed: shared viewport, watermark drag, presets, annotations, save, locales and narrow layout.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
