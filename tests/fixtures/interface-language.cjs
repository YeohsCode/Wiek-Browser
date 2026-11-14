'use strict';
const { app, BrowserWindow, Menu } = require('electron');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const phase = process.argv.at(-1);
const root = process.env.WIEK_LANGUAGE_APP_ROOT;

async function verify(window) {
  const js = code => window.webContents.executeJavaScript(code);
  const wait = async code => {
    for (let i = 0; i < 150; i++) {
      if (await js(code)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw Error('Interface did not reach the expected state: ' + code);
  };
  await wait('window.vek.state().then(s => s.spaces.length > 0)');
  const set = value => js(`window.vek.action('preferences:update', {interfaceLanguage:${JSON.stringify(value)}})`);
  const choose = value => js(`(() => { const select = document.querySelector('#interface-language'); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change')); })()`);
  if (phase === 'switch') {
    await set('en');
    await wait('document.documentElement.lang === "en"');
    await js('document.querySelector("[data-panel=settings]").click()');
    await wait('!!document.querySelector("#interface-language")');
    await choose('zh-CN');
  }
  await wait('document.documentElement.lang === "zh-CN"');
  assert.equal(await js('document.querySelector("[data-panel=settings] span").textContent'), '设置');
  assert.equal(await js('document.querySelector("#address").placeholder'), '搜索或输入网址');
  assert.equal(await js('document.querySelector(".brand-sub").textContent'), '你的浏览器，你的标签页');
  assert.ok(Menu.getApplicationMenu().items.some(item => item.label === '文件'));

  if (phase === 'switch') {
    assert.equal(await js('document.querySelector("#interface-language").getAttribute("aria-label")'), '界面语言');
    await js('window.vek.state().then(s => window.vek.action("space:create", {name:"Settings",profileId:s.profiles[0].id}))');
    await wait('[...document.querySelectorAll(".space-title")].some(node => node.textContent === "Settings")');
    const tabGroup = await js('window.vek.state().then(s => s.spaces.find(group => group.name === "Settings").id)');
    await js(`window.vek.action("space:open-window", ${tabGroup})`);
    const detached = BrowserWindow.getAllWindows().find(candidate => candidate !== window);
    assert.ok(detached);
    assert.equal(await detached.webContents.executeJavaScript('document.querySelector("#attach").textContent'), '返回主窗口');
    await set('en');
    for (let i = 0; i < 100; i++) {
      if (await detached.webContents.executeJavaScript('document.documentElement.lang') === 'en') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(await detached.webContents.executeJavaScript('document.querySelector("#attach").textContent'), 'Return to main window');
    await js(`window.vek.action("space:attach-window", ${tabGroup})`);
    await set('zh-CN');
    await wait('document.documentElement.lang === "zh-CN"');
    await js('document.querySelector("[data-panel=agents]").click()');
    await wait('document.querySelector("#agent-root h1")?.textContent === "智能体工作区"');
    const composition = await js(`(() => {
      const input = document.createElement('input');
      document.querySelector('#agent-root').append(input);
      input.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true, data:'zhong'}));
      window.WiekAgentPanel.update({});
      const retained = input.isConnected;
      input.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true, data:'中'}));
      return retained;
    })()`);
    assert.equal(composition, true);
    await js('document.querySelector("[data-panel=settings]").click()');
    await wait('!!document.querySelector("#interface-language")');
    await choose('en');
    await wait('document.documentElement.lang === "en"');
    assert.equal(await js('document.querySelector("[data-panel=settings] span").textContent'), 'Settings');
    await choose('zh-CN');
    await wait('document.documentElement.lang === "zh-CN"');
  } else {
    assert.equal(await js('window.vek.state().then(s => s.preferences.interfaceLanguage)'), 'zh-CN');
  }
  console.log('language-checks-passed');
  app.quit();
}
app.once('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', () => {
    void verify(window).catch(error => { console.error(error); app.exit(1); });
  });
});
require(join(root, 'app/main.cjs'));
