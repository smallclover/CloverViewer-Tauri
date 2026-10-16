const assert=require("node:assert/strict");
const test=require("node:test");
const loadTs=require("./helpers/load-ts.cjs");
test("system theme changes live while explicit preferences remain stable and disposal removes the listener", () => {
  let handler,removed=false;
  const query={matches:false,addEventListener:(_,fn)=>{handler=fn;},removeEventListener:(_,fn)=>{removed=fn===handler;}};
  const element={dataset:{}};
  const {createThemeController}=loadTs("ui/theme-controller.ts",{}, {window:{matchMedia:()=>query},document:{documentElement:element}});
  const theme=createThemeController();theme.set("system");assert.equal(element.dataset.theme,"light");
  query.matches=true;handler();assert.equal(element.dataset.theme,"dark");
  theme.set("light");handler();assert.equal(element.dataset.theme,"light");
  theme.set("dark");query.matches=false;handler();assert.equal(element.dataset.theme,"dark");
  theme.dispose();assert.equal(removed,true);
});
