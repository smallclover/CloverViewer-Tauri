// Optional browser QA: set CLOVER_PLAYWRIGHT_MODULE to an installed Playwright module.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
process.chdir(path.resolve(__dirname,'..'));
fs.mkdirSync('.unit-test-dist',{recursive:true});
const ts=require('../node_modules/typescript');
const {chromium}=require(process.env.CLOVER_PLAYWRIGHT_MODULE || 'playwright');
const modules=['ocr/layout','ocr/selection','ocr/geometry','ui/icons','viewer/ocr/image-overlay','viewer/ocr/result-list','viewer/ocr/panel-resize','viewer/image-ocr-controller','viewer/single-image-controller','locales/zh-CN','locales/en','locales/ja'];
const code=Object.fromEntries(modules.map(name=>[name,ts.transpileModule(fs.readFileSync('src/'+name+'.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText]));
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
 const page=await browser.newPage({viewport:{width:1200,height:850}});page.setDefaultTimeout(5000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const css=['base','viewer','image-ocr'].map(name=>fs.readFileSync('src/styles/'+name+'.css','utf8')).join('\n');
 const pic='<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="white"/><g font-family="Segoe UI" font-size="20" fill="black"><text x="50" y="75">第一段文字</text><text x="50" y="105">第二行文字</text><text x="180" y="275">最后一条消息</text><text x="180" y="305">需要点击或按下其他的键</text></g></svg>';
 await page.setContent('<style>'+css+'body{height:100vh;margin:0}#single-view{height:100vh}</style><div id="single-view"><div id="img-stage"><img id="single-img" src="data:image/svg+xml,'+encodeURIComponent(pic)+'"></div><aside id="image-ocr-panel" class="collapsed"></aside></div>');
 await page.evaluate(async({code})=>{
  const cache={};const load=name=>{if(cache[name])return cache[name];const out={};cache[name]=out;new Function('exports','require',code[name])(out,dep=>{const parts=name.split('/').slice(0,-1);for(const part of dep.split('/'))if(part==='..')parts.pop();else if(part!=='.')parts.push(part);return load(parts.join('/'));});return out;};
  document.documentElement.dataset.theme='light';
  window.lang=load('locales/zh-CN').zh;
  window.t=(key,params={})=>{let value=window.lang[key]??key;for(const [key,val]of Object.entries(params))value=value.replaceAll('{'+key+'}',String(val));return value;};
  window.setLang=name=>{window.lang=load('locales/'+name)[{en:'en',ja:'ja','zh-CN':'zh'}[name]];window.ocr.refreshTranslations();};
  window.image=document.getElementById('single-img');await image.decode();window.stage=document.getElementById('img-stage');window.copies=[];window.toasts=[];
  window.entry={path:'C:/test.png',size:1000,modified:'2026-10-24',width:800,height:500};image.dataset.imagePath=entry.path;
  window.single=load('viewer/single-image-controller').createSingleImageController({stage,getImage:()=>image,isActive:()=>true,getZoomSensitivity:()=>1,onChange:()=>{},onTransform:()=>window.ocr?.updateOverlay(),canPan:e=>ocr.canPan(e),allowFitPan:()=>ocr.allowFitPan()});
  window.ocr=load('viewer/image-ocr-controller').createImageOcrController({panel:document.getElementById('image-ocr-panel'),stage,getImage:()=>image,getEntry:()=>entry,isActive:()=>true,onLayout:()=>single.applyTransform(),panImage:(x,y)=>single.panBy(x,y),copyText:async text=>{if(window.failCopy)throw new Error('busy');window.copies.push(text);},translate:window.t,toast:text=>toasts.push(text),onClose:()=>ocr.close()});
  const line=(id,text,x,y,w)=>({id,text,quad:[{x,y},{x:x+w,y},{x:x+w,y:y+22},{x,y:y+22}]});
  window.doc={version:1,imageWidth:800,imageHeight:500,text:'fixture',lines:[line('a','第一段文字',50,55,240),line('b','第二行文字',50,85,240),line('c','最后一条消息',180,255,330),line('d','需要点击或按下其他的键',180,285,330)]};
  window.show=()=>{ocr.setResult(entry.path,doc,entry);ocr.open(entry);single.reset();};window.show();
  window.center=id=>{const svg=document.querySelector('.ocr-image-overlay'),m=svg.getScreenCTM(),l=doc.lines.find(l=>l.id===id);const p=new DOMPoint((l.quad[0].x+l.quad[2].x)/2,(l.quad[0].y+l.quad[2].y)/2).matrixTransform(m);return{x:p.x,y:p.y};};
  window.addEventListener('keydown',e=>{if(!e.defaultPrevented&&e.key==='r')single.rotate();});
 },{code});
 const row=page.locator('.ocr-result-row');await row.nth(1).waitFor();assert.equal(await row.count(),2);
 let p=await page.evaluate(()=>center('c'));await page.mouse.click(p.x,p.y);
 assert.equal(await row.nth(1).locator('input').isChecked(),true);
 await page.keyboard.press('Control+c');assert.equal(await page.evaluate(()=>copies.at(-1)),'最后一条消息需要点击或按下其他的键');
 await row.nth(0).locator('input').check();await page.getByRole('button',{name:'复制所选',exact:true}).click();assert.equal(await page.evaluate(()=>copies.at(-1)),'第一段文字第二行文字\n\n最后一条消息需要点击或按下其他的键');
 await page.getByRole('combobox',{name:'文字分组'}).selectOption('lines');assert.equal(await row.count(),4);assert.equal(await row.locator('input:checked').count(),4);
 await page.getByRole('button',{name:'清空',exact:true}).click();
 // Box around only line d, using its projected quad.
 const box=await page.evaluate(()=>{const m=document.querySelector('.ocr-image-overlay').getScreenCTM();return doc.lines[3].quad.map(p=>{const q=new DOMPoint(p.x,p.y).matrixTransform(m);return{x:q.x,y:q.y};});});
 await page.mouse.move(box[0].x-2,box[0].y-2);await page.mouse.down();await page.mouse.move(box[2].x+2,box[2].y+2,{steps:6});await page.mouse.up();assert.equal(await row.locator('input:checked').count(),1);assert.equal(await row.nth(3).locator('input').isChecked(),true);
 await page.getByRole('button',{name:'复制所选',exact:true}).click();assert.equal(await page.evaluate(()=>copies.at(-1)),'需要点击或按下其他的键');
 // Editing an original line edits its whole canonical paragraph.
 await row.nth(3).getByRole('button',{name:'修改',exact:true}).click();await row.locator('textarea').fill('修正后的消息\n手动换行');await row.getByRole('button',{name:'保存修改',exact:true}).click();assert.equal(await row.count(),3);assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'修改');
 await page.getByRole('button',{name:'复制所选',exact:true}).click();assert.equal(await page.evaluate(()=>copies.at(-1)),'修正后的消息\n手动换行');
 await page.getByRole('tab',{name:'全文',exact:true}).click();assert((await page.locator('.ocr-full-text').innerText()).includes('修正后的消息\n手动换行'));
 await page.getByRole('tab',{name:'分块',exact:true}).click();
 // Real native text selection gets first refusal on Ctrl+C.
 await page.locator('.ocr-row-text').first().evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);const s=window.getSelection();s.removeAllRanges();s.addRange(range);});
 let copies=await page.evaluate(()=>window.copies.length);await page.keyboard.press('Control+c');assert.equal(await page.evaluate(()=>window.copies.length),copies);await page.evaluate(()=>window.getSelection().removeAllRanges());
 // Exact transform equality through zoom, rotation and flips.
 await page.evaluate(()=>single.actualSize());await page.waitForTimeout(180);
 await page.evaluate(()=>single.rotate());assert.equal(await page.locator('.ocr-image-overlay').evaluate(el=>el.style.transform),await page.locator('#single-img').evaluate(el=>el.style.transform));
 await page.evaluate(()=>single.flipHorizontal());assert.equal(await page.locator('.ocr-image-overlay').evaluate(el=>el.style.transform),await page.locator('#single-img').evaluate(el=>el.style.transform));
 await page.getByRole('button',{name:'清空',exact:true}).click();p=await page.evaluate(()=>center('c'));await page.mouse.click(p.x,p.y);assert.equal(await row.nth(2).locator('input').isChecked(),true);
 await page.evaluate(()=>window.failCopy=true);await page.getByRole('button',{name:'复制所选',exact:true}).click();await page.waitForTimeout(20);assert.equal(await page.evaluate(()=>toasts.length),1);assert.equal(await row.nth(2).locator('input').isChecked(),true);await page.evaluate(()=>window.failCopy=false);
 // Reset image / selection and verify drag cancellation and space panning.
 await page.evaluate(()=>show());p=await page.evaluate(()=>center('a'));await page.mouse.click(p.x,p.y);
 await page.mouse.move(30,30);await page.mouse.down();await page.mouse.move(600,450);await page.keyboard.press('Escape');await page.mouse.up();assert.equal(await row.locator('input:checked').count(),1);
 const before=await page.locator('#single-img').evaluate(el=>el.style.transform);await page.keyboard.down('Space');await page.mouse.move(350,350);await page.mouse.down();await page.mouse.move(390,380);await page.mouse.up();await page.keyboard.up('Space');assert.notEqual(await page.locator('#single-img').evaluate(el=>el.style.transform),before);
 await page.evaluate(()=>show());
 // A sidebar click reveals an offscreen source without changing scale.
 await page.evaluate(()=>single.panBy(2000,2000));const oldScale=await page.evaluate(()=>single.displayedScale());await row.nth(0).locator('.ocr-row-text').click();assert.equal(await page.evaluate(()=>single.displayedScale()),oldScale);
 assert((await page.evaluate(()=>center('a'))).x<1200);
 await page.evaluate(()=>show());
 await page.getByRole('combobox',{name:'文字分组'}).selectOption('paragraphs');await page.screenshot({path:'.unit-test-dist/ocr-implemented-light.png'});
 for(const lang of ['en','ja','zh-CN'])for(const width of [1200,640,360]){
  await page.evaluate(lang=>setLang(lang),lang);await page.setViewportSize({width,height:850});await page.waitForTimeout(80);
  const geo=await page.evaluate(()=>({w:innerWidth,scroll:document.documentElement.scrollWidth,footer:document.querySelector('.ocr-result-footer').getBoundingClientRect().toJSON(),panel:document.querySelector('#image-ocr-panel').getBoundingClientRect().toJSON(),stacked:document.querySelector('#single-view').classList.contains('ocr-stacked')}));
  assert(geo.scroll<=geo.w,JSON.stringify(geo));assert(geo.footer.bottom<=850,JSON.stringify(geo));assert.equal(geo.stacked,width<900);
 }
 await page.setViewportSize({width:360,height:425});await page.waitForTimeout(80);
 const compact=await page.locator('#image-ocr-panel').evaluate(el=>({h:el.clientHeight,scroll:el.scrollHeight}));
 await page.getByRole('button',{name:'复制全部文本',exact:true}).scrollIntoViewIfNeeded();assert(await page.getByRole('button',{name:'复制全部文本',exact:true}).isVisible());
 await page.setViewportSize({width:360,height:850});await page.waitForTimeout(80);
 await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({path:'.unit-test-dist/ocr-implemented-narrow-dark.png'});
 await page.evaluate(()=>{image.dataset.imagePath='C:/other.png';ocr.updateOverlay();});assert.equal(await page.locator('.ocr-image-overlay').isVisible(),false);await page.evaluate(()=>{image.dataset.imagePath=entry.path;ocr.updateOverlay();});assert.equal(await page.locator('.ocr-image-overlay').isVisible(),true);
 await page.evaluate(()=>{ocr.close();ocr.setResult(entry.path,'legacy text',entry);ocr.open(entry);});assert.equal(await row.count(),1);assert.equal(await page.locator('.ocr-image-mode').isVisible(),false);
 await page.evaluate(()=>entry.modified='new');assert.equal(await page.evaluate(()=>ocr.hasResult(entry.path)),false);
 assert.deepEqual(errors,[]);console.log('PASS: source point/multiple/box selection, ordered clipboard, edited canonical text, native text selection, transform equality, cancel, space pan, 3 languages x 3 widths, legacy and invalidation');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
