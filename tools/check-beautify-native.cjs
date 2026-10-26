// Run a development app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9227.
// Uses an isolated generated image and the editor's overwrite confirmation to avoid native pickers.
const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");
process.chdir(path.resolve(__dirname,".."));
fs.mkdirSync(".unit-test-dist",{recursive:true});
const {chromium}=require(process.env.CLOVER_PLAYWRIGHT_MODULE || "playwright");
(async()=>{
 const browser=await chromium.connectOverCDP(process.env.CLOVER_CDP_URL || "http://127.0.0.1:9227");
 try {
  const context=browser.contexts()[0];
  const main=context.pages().find(p=>/localhost:5173\/$/.test(p.url()));
  assert(main,"Main WebView2 page not found");
  await main.reload({waitUntil:'networkidle'});
  main.setDefaultTimeout(10000); const errors=[];main.on("pageerror",e=>errors.push(e.message));
  const previousCapture=context.pages().find(p=>p.url().includes("screenshot.html"));
  if(previousCapture&&await previousCapture.evaluate(()=>document.body.classList.contains("ready")))
   await previousCapture.evaluate(async()=>{await(await import("/src/api.ts")).closeScreenshot();});
  const sourcePath=path.resolve(".unit-test-dist/beautify-native-source.png").replaceAll("\\","/");
  const outputPath=path.resolve(".unit-test-dist/beautify-native-output.png").replaceAll("\\","/");
  await main.evaluate(async({sourcePath,outputPath})=>{
   const api=await import("/src/api.ts");
   const c=document.createElement("canvas");c.width=800;c.height=500;const ctx=c.getContext("2d");
   ctx.fillStyle="#ffffff";ctx.fillRect(0,0,800,500);ctx.fillStyle="#15803d";ctx.fillRect(40,40,350,160);
   ctx.fillStyle="#111827";ctx.font="28px sans-serif";ctx.fillText("CloverViewer 图片美化测试",40,260);
   await api.saveEditedImage(sourcePath,c.toDataURL(),"png");
   await api.saveEditedImage(outputPath,c.toDataURL(),"png");
   await (await import("/node_modules/@tauri-apps/api/event.js")).emitTo("main","open-image",{path:outputPath});
  },{sourcePath,outputPath});
  await main.locator("#single-img").waitFor({state:"visible"});
  await main.evaluate(()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"e",ctrlKey:true,bubbles:true})));
  await main.locator('.image-editor-button[data-key="beautify.title"]').click();
  await main.getByRole("button",{name:"Mac 浅色窗口",exact:true}).click();
  await main.getByRole("button",{name:"水印",exact:true}).click();
  await main.getByRole("button",{name:"添加文字",exact:true}).click();
  await main.getByRole("textbox",{name:"水印文字"}).fill("Native WebView2 {date}");
  await main.waitForFunction(()=>!document.querySelector(".image-editor-beauty-preview").hidden);
  await main.screenshot({path:".unit-test-dist/beautify-native-editor.png"});
  await main.locator('.image-editor-button[data-key="editor.saveOptions"]').click();
  await main.locator('.image-editor-button[data-key="editor.overwrite"]').click();
  await main.locator('.image-editor-confirm-accept').click();
  await main.waitForFunction(()=>document.querySelector("#toast")?.textContent.includes("保存"));
  await main.waitForTimeout(300);
  assert(fs.existsSync(outputPath),"Decorated output was not written");
  const bytes=fs.readFileSync(outputPath);const w=bytes.readUInt32BE(16),h=bytes.readUInt32BE(20);
  assert(w>800&&h>500,`Frame missing from output: ${w}x${h}`);
  await main.locator('.image-editor-button[data-key="editor.cancel"]').click();
  await main.waitForFunction(()=>document.getElementById("image-editor-view").classList.contains("hidden"));
  // Screenshot toolbar -> beauty preview -> viewer, through the existing capture backend.
  await main.evaluate(async()=>{await (await import("/src/api.ts")).startCapture();});
  let shot=context.pages().find(p=>p.url().includes("screenshot.html"));
  if(!shot)shot=await context.waitForEvent("page");shot.setDefaultTimeout(30000);
  await shot.waitForFunction(()=>document.body.classList.contains("ready"));
  await shot.mouse.move(150,150);await shot.mouse.down();await shot.mouse.move(750,550,{steps:5});await shot.mouse.up();
  await shot.locator('.toolbar button[data-i18n-title="beautify.title"]').click();
  await main.locator('.image-editor-inspector').waitFor({state:'visible'});
  await main.waitForFunction(()=>!document.getElementById('image-editor-view').classList.contains('hidden'));
  await main.locator('.image-editor-inspector').getByRole('button',{name:'样式',exact:true}).click();
  await main.getByRole('button',{name:'照片装裱',exact:true}).click();
  await main.getByRole('button',{name:'黑框画廊',exact:true}).click();
  await main.waitForFunction(()=>!document.querySelector('.image-editor-beauty-preview').hidden);
  await main.screenshot({path:'.unit-test-dist/beautify-native-screenshot-editor.png'});
  assert.equal(await main.locator('dialog[open]').count(),0);
  assert.deepEqual(errors,[]);
  console.log(`Native WebView2 QA passed: integrated decoration saved as ${w}x${h}; screenshot opens the same editor and inspector.`);
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
