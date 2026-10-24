const assert=require("node:assert/strict");
const test=require("node:test");
const loadTs=require("./helpers/load-ts.cjs");

test("ordinary screenshot toolbar and its popups use the selection monitor and close on re-layout",()=>{
  const monitor={x:640,y:300,w:960,h:600};
  let selection={x:650,y:700,w:271,h:180},closes=0;
  const element=(w=608,h=44)=>{
    const events=new Map(),classes=new Set();
    return {style:{},offsetWidth:w,offsetHeight:h,
      addEventListener:(name,handler)=>events.set(name,handler),
      fire:name=>events.get(name)?.({stopPropagation(){}}),
      classList:{contains:name=>classes.has(name),add:name=>classes.add(name),remove:name=>classes.delete(name)},
      getBoundingClientRect(){const left=20+(parseFloat(this.style.left)||0),top=30+(parseFloat(this.style.top)||0);return {left,top,width:w,height:h,right:left+w,bottom:top+h};},
    };
  };
  const root=element(1600,900),toolbar=element(),colorBtn=element(32,32),widthBtn=element(64,32),colorPopup=element(180,150),widthPopup=element(196,400);
  root.getBoundingClientRect=()=>({left:20,top:30,width:1600,height:900});
  const {createEditorUiController}=loadTs("screenshot/editor-ui-controller.ts",{}, {
    window:{addEventListener(){}},ResizeObserver:class{observe(){}},
  });
  const ui=createEditorUiController({root,toolbarUi:{toolbar,colorBtn,widthBtn,colorPopup,widthPopup,closePopups(){closes++;colorPopup.classList.remove("open");widthPopup.classList.remove("open");},syncColor(){}},
    helpPanel:{element:element(280,100),sync(){}},getSelection:()=>selection,getAnchor:()=>({x:10,y:10}),toCssBox:value=>value,
    rootBox:()=>({x:0,y:0,w:1600,h:900}),monitorBox:()=>monitor,getColor:()=>"#f00",getCopyColorHotkey:()=>"Alt+C",getMagnifierActive:()=>true,
  });
  ui.sync();assert.equal(parseFloat(toolbar.style.left),648);assert.equal(toolbar.style.maxWidth,"944px");
  colorBtn.style.left="650";colorBtn.style.top="850";colorBtn.fire("click");
  assert.equal(colorPopup.classList.contains("open"),true);
  assert.equal(parseFloat(colorPopup.style.left),648);assert(parseFloat(colorPopup.style.top)+150<=892);
  widthBtn.style.left="1540";widthBtn.style.top="850";widthBtn.fire("click");
  assert.equal(colorPopup.classList.contains("open"),false);assert.equal(widthPopup.classList.contains("open"),true);
  assert(parseFloat(widthPopup.style.left)+196<=1592);assert(parseFloat(widthPopup.style.top)+400<=892);
  assert.equal(widthPopup.style.maxHeight,"584px");
  const before=closes;selection={...selection,x:660};ui.sync();
  assert.equal(widthPopup.classList.contains("open"),false);assert.equal(closes,before+1);
});
