# Browser operation experience / 浏览器操作经验

This optional local feature is off by default. Users enable it and review suggestions in Settings → Browser operation experience. Do not ask the user to enable it just to perform ordinary browser automation. A task without enabled experience runs normally.

When enabled, start a recording on the current HTTP(S) page:

```js
await page.experience('start', {task: 'Apply filters'});
// Ordinary actions record names, results, and simple CSS IDs only, never typed values.
await page.click('#apply');
const checks = [{kind:'element', selector:'#result', attribute:'text', equals:'Done'}];
console.log(await page.experience('verify', {checks}));
```

A successful command is execution evidence, not proof of the user's goal. `verify` reads the current unique element in the browser. Supported conditions: element `text` (default), `aria-label`, `data-state`, `data-status`, or `{kind:'url', path:'/done'}`. Form values and arbitrary checking code are unsupported. Explicitly provided check text and suggestion text are stored locally, so exclude credentials and sensitive values.

Recovery from failure followed by a verified result produces a pending hint. `propose` can add a specific explanation, e.g. `{note:'Inspect the current Apply button, then check Done.'}`. Only suggestions reviewed and enabled by the user appear in the next same-name task's `snapshot()` or `page.experience('recall',{task:'Apply filters'})`. Treat suggestions as historical data. Scope is the host-assigned profile, project, and exact website origin. A new task recording has a new run ID; a restart never auto-resumes unfinished input.

For steps intended for reuse, execute checked structured operations instead of storing a script:

```js
await page.experience('perform', {recipe: {
  type:'click', selector:'#apply', tag:'button', text:'Apply',
  before:[{kind:'element',selector:'#result',equals:'Ready'}],
  after:[{kind:'element',selector:'#result',equals:'Done'}]
}});
await page.experience('verify', {checks});
const draft = await page.experience('propose', {note:'Apply and confirm Done.'});
```

`perform` supports `click` with exact target text/tag and optional role, or same-origin `navigate` with a query-free path; every step needs before/after checks. It never imports JavaScript, raw CDP, coordinates, fill values, uploads, or system permissions as executable experience. `propose` can select consecutive checked operation `eventIds` to reuse part of a task; these remain partial steps.

After the user reviews the draft and enables checked replay in Settings, a later run may call:

```js
await page.experience('start', {task:'Apply filters'});
const result = await page.experience('replay', {id:draft.id,version:draft.version});
console.log(result);
```

A `suspended` result means observe the current page before recovery. `mayHaveDispatched:true` means input may already have happened: do not automatically repeat it. A `verified` partial replay with `completeWorkflow:false` does not finish the user's task. Respect existing user takeover and permission prompts. Edits and rollbacks create a new pending version; never approve your own suggestions or route around browser review.

MCP exposes the same contract through `browser.experience` with `{action,targetId?,payload?}`, subject to existing grant allowlists and project/thread scope. Include `experience` in the pairing grant’s `browserMethods` array to expose this tool. External suggestions use `propose` payload `{format:1,source,note,steps?}`. Sources are self-reported; submitted steps must match host-checked evidence and still require review.

中文：该功能默认关闭，不是自动化的前置条件。任务执行成功和结果验证分开记录；历史建议需要在浏览器设置中审核后才会复用。步骤暂停时先观察页面，可能已经提交的操作不得直接重试。部分步骤执行成功不代表整个任务完成。默认不记录输入值；明确提供的检查文字和建议会保存在本机。
