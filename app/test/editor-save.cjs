// Real renderer regression: delayed IPC success/failure must not lose edits.
const { app, BrowserWindow, ipcMain } = require('electron');
const { join } = require('node:path');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'dobstudio-editor-test-')));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let release, calls = 0, failNext = false;
const project = { id: 'test', name: 'Save test', source: 'https://example.invalid/test.mp4', revision: 0,
  cues: [{ index: 1, startMs: 0, endMs: 1000, text: 'original', translation: 'translation' }] };
let win;
const deadline = setTimeout(() => { console.error('Editor regression timed out'); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  ipcMain.handle('studio:snapshot', () => ({ projects: [project], jobs: [], settings: { python: 'python', modelPath: '', device: 'cpu' } }));
  ipcMain.handle('studio:mediaUrl', () => null);
  ipcMain.handle('studio:saveCues', async (_event, id, revision, cues) => {
    calls++;
    await new Promise(resolve => { release = resolve; });
    if (failNext) { failNext = false; throw new Error('Simulated save failure'); }
    assert.equal(id, project.id); assert.equal(revision, project.revision);
    project.cues = cues; project.revision++;
    win.webContents.send('studio:changed');
    return project;
  });
  win = new BrowserWindow({ show: false, webPreferences: { preload: join(__dirname, '../dist-electron/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(join(__dirname, '../dist/index.html'));
  const js = code => win.webContents.executeJavaScript(code);
  async function waitFor(expression) {
    for (let i = 0; i < 150; i++) { if (await js(expression)) return; await delay(20); }
    throw new Error('Renderer condition failed: ' + expression);
  }
  await waitFor(`!!document.querySelector('.project-card')`);
  await js(`document.querySelector('.project-card').click()`);
  await waitFor(`!!document.querySelector('.cue textarea')`);
  const edit = text => js(`(() => { const field=document.querySelector('.cue textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(text)}); field.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const saveButton = `document.querySelector('.section-heading button')`;
  await edit('first edit');
  await waitFor(`!${saveButton}.disabled`);
  await js(`${saveButton}.click(); ${saveButton}.click()`);
  await waitFor(`${saveButton}.textContent.includes('正在保存')`);
  assert.equal(calls, 1, 'double click must not duplicate IPC save');
  assert.equal(await js(`[...document.querySelectorAll('.cue input,.cue textarea')].every(x=>x.disabled)`), true);
  // Even synthetic input events during the lock must not change React state.
  await edit('must not be saved');
  release();
  await waitFor(`${saveButton}.textContent.trim()==='保存字幕' && !document.querySelector('.cue textarea').disabled`);
  assert.equal(project.cues[0].text, 'first edit');
  assert.equal(await js(`document.querySelector('.cue textarea').value`), 'first edit');
  await edit('retry edit');
  failNext = true;
  await waitFor(`!${saveButton}.disabled`);
  await js(`${saveButton}.click()`);
  await waitFor(`${saveButton}.textContent.includes('正在保存')`);
  release();
  await waitFor(`!!document.querySelector('[role="alert"]') && !${saveButton}.disabled`);
  assert.equal(await js(`document.querySelector('.cue textarea').value`), 'retry edit');
  assert.equal(await js(`document.querySelector('.section-heading small').textContent.includes('未保存')`), true);
  assert.equal(await js(`document.querySelector('.cue textarea').disabled`), false);
  await js(`${saveButton}.click()`);
  await waitFor(`${saveButton}.textContent.includes('正在保存')`);
  release();
  await waitFor(`document.querySelector('.section-heading small').textContent.includes('已保存')`);
  assert.equal(project.cues[0].text, 'retry edit');
  assert.equal(project.revision, 2);
  assert.equal(calls, 3);
  console.log('PASS: delayed save locks edits, prevents double submission, and preserves edits on failure/retry');
  clearTimeout(deadline);
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
