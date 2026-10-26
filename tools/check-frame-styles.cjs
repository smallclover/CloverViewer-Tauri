// Canvas QA and a contact sheet of the actual renderer, independent of the native app.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const ts = require('../node_modules/typescript');
const {chromium} = require(process.env.CLOVER_PLAYWRIGHT_MODULE || 'playwright');
process.chdir(path.resolve(__dirname,'..'));
fs.mkdirSync('.unit-test-dist',{recursive:true});
const files = fs.readdirSync('src/image-beautify').filter(n=>n.endsWith('.ts'));
const code = Object.fromEntries(files.map(file=>[file.slice(0,-3),ts.transpileModule(fs.readFileSync('src/image-beautify/'+file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText]));
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1400,height:950}});
  const photo='data:image/webp;base64,'+fs.readFileSync('site/assets/alpine-lake.webp').toString('base64');
  await page.route('http://localhost:4179/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Frame QA</title>'}));
  await page.goto('http://localhost:4179/');
  const result=await page.evaluate(async({code,photo})=>{
   const cache={};const load=name=>{
    if(cache[name])return cache[name];const out={};cache[name]=out;
    new Function('exports','require',code[name])(out,dep=>dep==='../api'?{}:load(dep.slice(2)));return out;
   };
   const {renderBeauty}=load('renderer'),{builtinPresets,legacyPresets}=load('presets');
   const {rebaseBeauty,migrateBeauty,emptyBeauty}=load('model');
   const time=new Date(2026,9,25,8,9,3);
   const image=new Image();image.src=photo;await image.decode();
   const picture=document.createElement('canvas');picture.width=800;picture.height=500;picture.getContext('2d').drawImage(image,0,0,800,500);
   function dashboard(dark){
    const canvas=document.createElement('canvas');canvas.width=800;canvas.height=500;const c=canvas.getContext('2d');
    c.fillStyle=dark?'#20262b':'#fbfcfc';c.fillRect(0,0,800,500);
    c.fillStyle=dark?'#1b2227':'#eef2f0';c.fillRect(0,0,150,500);
    c.font='600 19px Segoe UI';c.fillStyle=dark?'#a5c5b2':'#536f61';c.fillText('CLOVER',25,52);
    c.font='14px Segoe UI';['Overview','Library','Collections','Settings'].forEach((s,i)=>{c.fillStyle=i===0?(dark?'#bfd8ca':'#3b6550'):(dark?'#73877e':'#92a198');c.fillText(s,25,112+i*44);});
    c.fillStyle=dark?'#d8e4dc':'#3e5a4c';c.font='600 26px Segoe UI';c.fillText('Workspace overview',192,63);
    c.font='14px Segoe UI';c.fillStyle=dark?'#899b92':'#93a098';c.fillText('Everything you need, in one place.',193,92);
    [0,1,2].forEach((_,i)=>{c.fillStyle=dark?'#2b3933':'#e9f0ec';c.beginPath();c.roundRect(192+i*190,125,173,85,9);c.fill();c.fillStyle=dark?'#bfd1c5':'#62806f';c.font='12px Segoe UI';c.fillText(['IMAGES','COLLECTIONS','THIS WEEK'][i],207+i*190,150);c.font='600 25px Segoe UI';c.fillText(['2,408','24','+18%'][i],207+i*190,185);});
    c.fillStyle=dark?'#cbdad2':'#526e5e';c.font='600 16px Segoe UI';c.fillText('Activity',193,257);
    c.strokeStyle=dark?'#37453e':'#e1e8e3';c.beginPath();c.moveTo(193,415);c.lineTo(745,415);c.stroke();
    [25,40,32,66,54,80,68,95,86,100,78,92].forEach((n,i)=>{c.fillStyle=dark?'#71a58a':'#94b6a2';c.beginPath();c.roundRect(203+i*45,410-n*1.3,25,n*1.3,4);c.fill();});
    c.font='12px Segoe UI';c.fillStyle=dark?'#73877e':'#92a198';c.fillText('MON',204,447);c.fillText('WED',390,447);c.fillText('FRI',568,447);c.fillText('SUN',702,447);
    return canvas;
   }
   const outputs=[],checks=[];
   const render=(source,beauty,extra={})=>renderBeauty({source,document:beauty,time,assets:new Map(),...extra});
   const equal=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
   for(const preset of builtinPresets()){
    const source=['mac-light','browser'].includes(preset.id)?dashboard(false):preset.id==='mac-dark'?dashboard(true):picture;
    const beauty=structuredClone(preset.document);
    if(['mac-light','mac-dark'].includes(preset.id))beauty.frame.style.title='Clover Workspace';
    if(preset.id==='polaroid')beauty.frame.style.caption='Somewhere quiet.';
    const output=render(source,beauty), l=output.layout;
    const rebased=render(source,rebaseBeauty(beauty,800,500));
    const a=output.canvas.getContext('2d').getImageData(0,0,l.width,l.height).data;
    const b=rebased.canvas.getContext('2d').getImageData(0,0,l.width,l.height).data;
    if(!equal(a,b))throw Error(preset.id+': rebase changed appearance');
    for(const [x,y] of [[20,20],[400,250],[780,480]]){
      const a=source.getContext('2d').getImageData(x,y,1,1).data;
      const b=output.canvas.getContext('2d').getImageData(l.content.x+x,l.content.y+y,1,1).data;
      if(!equal(a,b))throw Error(preset.id+': source content changed');
    }
    const half=render(source,beauty,{scale:0.5});
    if(half.canvas.width!==Math.round(l.width/2)||half.canvas.height!==Math.round(l.height/2))throw Error('Incorrect export scale');
    const transparent=structuredClone(beauty);transparent.background.kind='transparent';
    if(render(source,transparent).canvas.getContext('2d').getImageData(0,0,1,1).data[3]!==0)throw Error('Transparent margin was painted');
    if(render(source,transparent,{whiteBackground:true}).canvas.getContext('2d').getImageData(0,0,1,1).data[3]!==255)throw Error('JPEG white background missing');
    const disabled=structuredClone(beauty);disabled.enabled=false;
    const plain=render(source,disabled);
    if(plain.canvas.width!==800||plain.canvas.height!==500)throw Error('Disabled frame changes geometry');
    outputs.push({id:preset.id,url:output.canvas.toDataURL(),width:l.width,height:l.height});
    checks.push(preset.id);
   }
   for(const kind of ['solid','gradient']){
    const old=emptyBeauty();delete old.background;old.enabled=true;old.frame.kind=kind;
    const a=render(picture,old).canvas,b=render(picture,migrateBeauty(old)).canvas;
    if(!equal(a.getContext('2d').getImageData(0,0,a.width,a.height).data,b.getContext('2d').getImageData(0,0,b.width,b.height).data))throw Error('Legacy visual migration failed');
   }
   if(legacyPresets().length!==4)throw Error('Legacy presets missing');
   const odd=document.createElement('canvas');odd.width=1001;odd.height=667;
   const oddContext=odd.getContext('2d');oddContext.fillStyle='#e13968';oddContext.fillRect(0,0,1001,667);
   oddContext.fillStyle='#ffffff';oddContext.fillRect(500,333,1,1);
   for(const preset of builtinPresets()){
    const result=render(odd,preset.document),l=result.layout;
    if(!Number.isInteger(l.content.x)||!Number.isInteger(l.content.y))throw Error('Fractional content placement');
    if(!equal(result.canvas.getContext('2d').getImageData(l.content.x+500,l.content.y+333,1,1).data,[255,255,255,255]))throw Error('Screenshot pixels resampled');
    if(['mac-light','mac-dark','browser'].includes(preset.id)){
     preset.document.frame.style.titleBarHeight=0;preset.document.frame.borderWidth=1.4;render(odd,preset.document);
    }
   }
   const zeroPaper=builtinPresets().find(p=>p.id==='polaroid').document;
   zeroPaper.background.kind='transparent';zeroPaper.frame.shadow=0;
   Object.assign(zeroPaper.frame.style,{matWidth:0,paperBottom:0,caption:'Must stay inside paper',captionDate:true});
   const zero=render(picture,zeroPaper),z=zero.layout;
   if(zero.canvas.getContext('2d').getImageData(z.content.x,z.content.y+z.content.h+1,z.content.w,20).data.some((v,i)=>i%4===3&&v!==0))throw Error('Paper caption leaked into background');
   // Extreme aspect ratios and long labels must remain clipped to their own frame.
   for(const [w,h]of [[40,800],[800,40]]){
    const source=document.createElement('canvas');source.width=w;source.height=h;
    for(const preset of builtinPresets()){
     preset.document.frame.style.title=preset.document.frame.style.url=preset.document.frame.style.caption='Long title / 地址 / キャプション '.repeat(12);
     const result=render(source,preset.document,{previewLimit:500});
     if(!result.canvas.width||!result.canvas.height)throw Error('Extreme aspect failed');
    }
   }
   const large=document.createElement('canvas');large.width=3840;large.height=2160;
   const timings=builtinPresets().map(p=>{const start=performance.now();const r=render(large,p.document,{previewLimit:1600});r.canvas.getContext("2d").getImageData(0,0,1,1);r.canvas.width=r.canvas.height=0;return {id:p.id,ms:Math.round((performance.now()-start)*10)/10};});
   return {outputs,checks,timings};
  },{code,photo});
  for(const output of result.outputs)fs.writeFileSync('.unit-test-dist/frame-'+output.id+'.png',Buffer.from(output.url.split(',')[1],'base64'));
  const labels=['Mac 浅色窗口','Mac 深色窗口','极简浏览器','黑框画廊','浅木装裱','拍立得纸框'];
  const details=['完整标题栏 · 三色按钮 · 柔和投影','石墨框体 · 边缘高光 · 深色背景','独立地址栏 · 细描边 · 清爽底色','黑色框条 · 暖白卡纸 · 内凹压边','定向木纹 · 45° 拼角 · 双层衬边','纸张质感 · 底部留白 · 署名与日期'];
  await page.setContent(`<style>*{box-sizing:border-box}body{margin:0;padding:40px 42px 30px;background:#f9faf9;color:#25342f;font-family:'Segoe UI','Microsoft YaHei',sans-serif}h1{font-size:28px;font-weight:600;margin:8px 0 24px}.eyebrow{font-size:11px;letter-spacing:.16em;color:#698178}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:28px 22px}.stage{height:295px;display:grid;place-items:center;background:#ecefea;border-radius:11px;overflow:hidden}.stage img{width:100%;height:100%;object-fit:contain}.caption{display:flex;align-items:center;gap:12px;margin:13px 0 5px;font-size:16px;font-weight:600}.num{font-size:11px;font-weight:400;color:#8a978e}p{font-size:11px;color:#6f7f77;margin:0;line-height:1.6}footer{border-top:1px solid #dce3dd;margin-top:28px;padding-top:15px;font-size:11px;color:#7b8880}</style><div class="eyebrow">CLOVERVIEWER · SIX FRAME STYLES</div><h1>六种相框，已接入图片编辑器</h1><main class="grid">${result.outputs.map((o,i)=>`<article><div class="stage"><img src="${o.url}"></div><div class="caption"><span class="num">0${i+1}</span>${labels[i]}</div><p>${details[i]}</p></article>`).join('')}</main><footer>实际 Canvas 渲染与导出效果 · 使用项目现有照片和模拟软件界面 · 预设缩略图复用相同渲染器</footer>`);
  await page.locator('img').evaluateAll(async images=>Promise.all(images.map(image=>image.decode())));
  await page.screenshot({path:'.unit-test-dist/frame-styles-implemented.png',fullPage:true});
  assert.equal(result.checks.length,6);
  console.log(JSON.stringify({passed:result.checks,timings:result.timings,dimensions:result.outputs.map(({id,width,height})=>({id,width,height}))},null,2));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
