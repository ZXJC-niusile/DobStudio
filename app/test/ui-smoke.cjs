const { app, BrowserWindow, ipcMain } = require('electron');
const { join } = require('node:path');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'dobstudio-ui-')));
const output = process.env.DOBSTUDIO_UI_REPORT_DIR;
if (output) mkdirSync(output, { recursive: true });
const projects = [];
const jobs = [];
const settings = { python: 'python', modelPath: '', xttsModelPath: '', device: 'cpu', defaultTtsEngine: 'cosyvoice' };
let win, picks = 0;
const errors = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
const deadline = setTimeout(() => { console.error('UI regression timeout'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  ipcMain.handle('studio:snapshot', () => ({ projects, jobs, settings }));
  ipcMain.handle('studio:mediaUrl', () => null);
  ipcMain.handle('studio:status', () => ['ffmpeg','ffprobe','whisper.cpp','yt-dlp'].map(name=>({name,present:false})));
  ipcMain.handle('studio:pick', () => { picks++; return null; });
  ipcMain.handle('studio:createProject', (_e, source) => {
    const p = {id:'imported',name:'链接导入项目',source,revision:0,cues:[]}; projects.unshift(p); win.webContents.send('studio:changed'); return p;
  });
  win = new BrowserWindow({ show:false,width:1440,height:1000,useContentSize:true,webPreferences:{offscreen:true,preload:join(__dirname,'../dist-electron/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false} });
  win.webContents.on('console-message', event=>{if(event.level==='error')errors.push(event.message);});
  win.webContents.on('preload-error', (_e,_p,error)=>errors.push(error.message));
  await win.loadFile(join(__dirname,'../dist/index.html'));
  const js = code=>win.webContents.executeJavaScript(code);
  async function waitFor(code) {for(let i=0;i<150;i++){if(await js(code))return;await delay(20);}throw Error(code);}
  const input = (selector,value)=>js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  async function capture(name){if(output){win.webContents.invalidate();await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await delay(600);writeFileSync(join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());}}
  async function fit(){assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'),true,'horizontal overflow');}
  await waitFor(`!!document.querySelector('[data-testid="studio-ready"]')`);
  await capture('01-home-empty');
  await js(`document.querySelector('.hero-actions .primary').click()`); await delay(60);assert.equal(picks,1);
  const cues=[{index:1,startMs:0,endMs:3200,text:'每一段旅程，都始于一个新的视角。',translation:'Every journey begins with a new perspective.'},{index:2,startMs:3500,endMs:6800,text:'循着光的方向，发现平凡里的不平凡。',translation:'Follow the light. Find the extraordinary in the ordinary.'},{index:3,startMs:7000,endMs:10000,text:'让世界听见，你的故事。',translation:'Let the world hear your story.'}];
  projects.push({id:'film',name:'光的旅程 · The journey of light.mp4',source:'https://example.invalid/film.mp4',revision:2,cues}, {id:'city',name:'城市漫游 · City after hours.mp4',source:'https://example.invalid/city.mp4',revision:0,cues:[]}, {id:'voice',name:'创作者访谈 · Behind the voice.mp4',source:'https://example.invalid/voice.mp4',revision:1,cues:cues.slice(0,1)});
  jobs.push({id:'done',projectId:'film',kind:'subtitles',status:'done',stage:'done',result:{srtPath:'sample.srt',projectRevision:2}});
  win.webContents.send('studio:changed');await waitFor(`document.querySelectorAll('.project-card').length===3`);
  await capture('02-home-projects');await fit();
  await input('[data-project-search]','城市');await waitFor(`document.querySelectorAll('.project-card').length===1`);
  assert.equal(await js(`document.querySelector('.project-card h3').textContent.includes('城市')`),true);
  await input('[data-project-search]','');await waitFor(`document.querySelectorAll('.project-card').length===3`);
  await js(`document.querySelectorAll('.library-filters button')[1].click()`);await waitFor(`document.querySelectorAll('.project-card').length===2`);
  await js(`document.querySelectorAll('.library-filters button')[2].click()`);await waitFor(`document.querySelectorAll('.project-card').length===1`);
  await js(`document.querySelectorAll('.library-filters button')[0].click();document.querySelector('[aria-label="列表视图"]').click()`);await waitFor(`!!document.querySelector('.project-list')`);
  await capture('03-project-list');
  await js(`document.querySelector('.project-card').click()`);await waitFor(`!!document.querySelector('.cue textarea')`);await capture('04-subtitles');await fit();
  for (const route of ['dubbing','tasks','settings']) {await js(`document.querySelector('[data-route="${route}"]').click()`);await delay(250);await capture('05-'+route);await fit();}
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))`);await waitFor(`document.activeElement?.hasAttribute('data-project-search')`);
  await js(`document.querySelector('[aria-label="网格视图"]').click();document.querySelector('.hero-actions .text-button').click()`);await waitFor(`document.querySelector('dialog').open`);
  await capture('06-link-import');await input('dialog input','https://example.invalid/new.mp4');await js(`document.querySelector('dialog form').requestSubmit()`);await waitFor(`!document.querySelector('dialog').open && !!document.querySelector('.editor-workspace')`);assert.equal(projects[0].id,'imported');
  await js(`document.querySelector('[data-route="projects"]').click()`);await delay(80);
  for(const width of [1080,800]) {win.setContentSize(width,900);await delay(250);await fit();await capture('07-home-'+width);}
  assert.deepEqual(errors,[]);
  console.log('PASS: import, search, filters, view switch, keyboard navigation, all routes and responsive widths');
  clearTimeout(deadline);app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
