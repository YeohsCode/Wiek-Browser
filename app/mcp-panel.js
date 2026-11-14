'use strict';

(() => {
  const tr = (message, ...values) => globalThis.WiekI18n?.t(message, ...values) ?? message.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index]) : match);
  function createPanel(root, invoke, initialContext = {}) {
    let data = { integrations: [], tasks: [], grants: [], connections: [], gateway: null }, context = initialContext;
    let projectId = context.projects?.[0]?.id || '', threadId = '', view = 'integrations', error = '', pending = false, dialog = null, destroyed = false;
    const tools = new Map(), resourceSections = new Map();
    const make = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
    const button = (label, action, cls = '') => { const node = make('button', label, `vm-button ${cls}`); node.type = 'button'; node.onclick = action; node.disabled = pending; return node; };
    const scope = () => ({ projectId, ...(threadId ? { threadId } : {}) });
    const scopeName = value => `${context.projects?.find(p => p.id === value?.projectId)?.name || value?.projectId || 'Project'}${value?.threadId ? ' / ' + (context.threads?.find(t => t.id === value.threadId)?.title || value.threadId) : ' / all threads'}`;
    const visible = owner => owner?.projectId === projectId && (!owner.threadId || owner.threadId === threadId);
    function update(next, nextContext) {
      if (nextContext) context = nextContext;
      if (next?.agents) context = { ...context, projects: next.agents.projects || context.projects, threads: next.agents.threads || context.threads };
      const incoming = next?.mcp || next;
      if (Array.isArray(incoming?.integrations) && Array.isArray(incoming?.tasks)) data = incoming;
      if(dialog?.reviewId&&!data.tasks.some(t=>t.id===dialog.taskId&&t.inputReview?.id===dialog.reviewId))dialog=null;
      if (!context.projects?.some(p => p.id === projectId)) { projectId = context.projects?.[0]?.id || ''; threadId = ''; }
      render();
    }
    async function action(name, payload, { close = true } = {}) {
      pending = true; error = ''; render();
      try {
        const result = await invoke(name, payload);
        if (result?.error) throw new Error(result.error);
        if (result?.integrations && result?.tasks) update(result);
        else { const snapshot = await invoke('mcp:snapshot', {}); update(snapshot); }
        if (close) dialog = null;
        return result;
      } catch (failure) { error = failure.message || String(failure); }
      finally { pending = false; render(); }
    }
    function field(label, key, value = '', multiline = false) { return { label, key, value, multiline }; }
    function editIntegration(item, transport = 'stdio') {
      if (!projectId) return;
      if ((item?.transport || transport) === 'http') {
        dialog = {title:item?tr("Configure HTTP MCP server"):tr("Add an HTTP MCP server"),fields:[field(tr("Name"),'name',item?.name||''),field(tr("MCP endpoint URL"),'url',item?.url||'https://'),field(tr("Protocol version — 2025-11-25 (session) or 2026-07-28 (per request)"),'protocolVersion',item?.protocolVersion||'2025-11-25'),field(tr("Header references — JSON object, for example {\"Authorization\":\"env:MCP_AUTH_HEADER\"}"),'headerRefs',JSON.stringify(item?.headerRefs||{}),true),field(tr("Allow HTTP for loopback only — true or false"),'allowInsecureHttp',String(item?.allowInsecureHttp===true)),{...field(tr("OAuth registration"),'oauthRegistration',item?.oauth?.registration||'preregistered'),options:[{value:'preregistered',label:tr("Pre-registered public client")},{value:'metadata',label:tr("HTTPS Client ID Metadata Document")},{value:'dynamic',label:tr('Register a public client with the issuer')}]},{...field(tr("OAuth public client ID or HTTPS metadata URL — optional"),'oauthClientId',item?.oauth?.clientId||''),optional:true},{...field(tr("Expected authorization server issuer — optional"),'oauthIssuer',item?.oauth?.issuer||''),optional:true},field(tr("OAuth scopes — JSON array, or null for server challenge"),'oauthScopes',JSON.stringify(item?.oauth?.scopes??null)),field(tr("OAuth loopback port — 0 for automatic, or registered port"),'oauthRedirectPort',String(item?.oauth?.redirectPort||0))],notice:tr("Scope: {0}. Each thread has an isolated connection. The selected protocol controls session or per-request behavior. Referenced environment variables contain complete header values (for example Bearer …). OAuth uses a pre-registered public client or your hosted HTTPS Client ID Metadata Document, S256 PKCE and secure OS storage. Metadata mode requires a fixed port and the exact http://127.0.0.1:PORT/oauth/callback in that document. Save first, then use Client metadata to host for a JSON template. Wiek does not publish it. Automatic ports are available only for pre-registered native clients. Dynamic registration requires an expected issuer and a fixed port. Leave the client ID empty. Authorization headers and OAuth cannot be combined. Saving a new endpoint/client/scope clears existing sign-in.", (scopeName(item?.scope||scope()))),submit:values=>{if(values.oauthRegistration==='metadata'&&!values.oauthClientId.trim())throw new Error(tr("Metadata registration requires an HTTPS client ID URL."));let refs;try{refs=JSON.parse(values.headerRefs)}catch{throw new Error(tr("Header references must be valid JSON."))}if(!refs||typeof refs!=='object'||Array.isArray(refs))throw new Error(tr("Header references must be a JSON object."));if(!['true','false'].includes(values.allowInsecureHttp))throw new Error(tr("Allow HTTP must be true or false."));return action('mcp:integrations:save',{...(item?{id:item.id}:{}),name:values.name,transport:'http',url:values.url,protocolVersion:values.protocolVersion,headerRefs:refs,allowInsecureHttp:values.allowInsecureHttp==='true',scope:item?.scope||scope(),enabled:item?.enabled!==false,...((values.oauthClientId.trim()||values.oauthRegistration==='dynamic')?{oauth:{...(values.oauthClientId.trim()?{clientId:values.oauthClientId.trim()}:{}),registration:values.oauthRegistration,...(values.oauthIssuer.trim()?{issuer:values.oauthIssuer.trim()}:{}),redirectPort:Number(values.oauthRedirectPort),...(JSON.parse(values.oauthScopes)===null?{}:{scopes:JSON.parse(values.oauthScopes)})}}:{})})}};render();return;
      }
      dialog = { title: item ? tr("Configure MCP server") : tr("Add a local MCP server"), fields: [field(tr("Name"), 'name', item?.name || ''), field(tr("Executable name or absolute path"), 'command', item?.command || ''),{...field(tr("Protocol version"),'protocolVersion',item?.protocolVersion||'2025-11-25'),options:[{value:'2025-11-25',label:tr("2025-11-25 · initialization")},{value:'2026-07-28',label:tr("2026-07-28 · per request")}]}, field(tr("Arguments — JSON array, without secrets"), 'args', JSON.stringify(item?.args || []), true), field(tr("Credential references — JSON object, for example {\"API_KEY\":\"env:MY_API_KEY\"}"), 'credentialRefs', JSON.stringify(item?.credentialRefs || {}), true)], notice: tr("Scope: {0}. Each thread gets a separate server process. Use credential references; their values are never entered in this form.", (scopeName(item?.scope || scope()))), submit: values => {
        let args, refs; try { args = JSON.parse(values.args); refs = JSON.parse(values.credentialRefs); } catch { throw new Error(tr("Arguments and credential references must be valid JSON.")); }
        if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string') || !refs || Array.isArray(refs) || typeof refs !== 'object') throw new Error(tr("Arguments must be an array of strings and references an object."));
        return action('mcp:integrations:save', { ...(item ? { id: item.id } : {}), name: values.name, command: values.command,protocolVersion:values.protocolVersion, args, credentialRefs: refs, scope: item?.scope || scope(), enabled: item?.enabled !== false });
      } }; render();
    }
    function toolCall(integration, tool) {
      dialog = { title: tool.name, notice: tool.description || tr("Run this tool in the selected project/thread scope."), fields: [field(tr("Arguments — JSON object"), 'arguments', '{}', true), field(tr("Timeout in milliseconds"), 'timeoutMs', '30000')], submit: async values => {
        let args; try { args = JSON.parse(values.arguments); } catch { throw new Error(tr("Arguments must be valid JSON.")); }
        const result = await action('mcp:tasks:create', { integrationId: integration.id, scope: scope(), name: tool.name, arguments: args, timeoutMs: Number(values.timeoutMs) });
        if (result) { view = 'tasks'; render(); }
      } }; render();
    }
    async function listTools(integration) {
      const result = await action('mcp:tools:list', { integrationId: integration.id, scope: scope() });
      if (result && integration.protocolVersion!=='2026-07-28') tools.set(`${integration.id}:${projectId}:${threadId}`, result.tools); render();
    }
    async function readResource(integration, uri, interactive=false) {
      const selectedScope = JSON.stringify(scope());
      if(interactive){
        const task=await action('mcp:resources:readInteractive',{integrationId:integration.id,scope:scope(),uri});
        if(task&&selectedScope===JSON.stringify(scope())){view='tasks';render();}
        return;
      }
      const result = await action('mcp:resources:read', { integrationId: integration.id, scope: scope(), uri });
      if (!result || selectedScope !== JSON.stringify(scope())) return;
      const contents = result.contents.map(row => row.blob === undefined ? row : { uri: row.uri, mimeType: row.mimeType, binaryBase64Characters: row.blob.length });
      dialog = { title: tr("Resource contents"), readonly: true, notice: result.stale ? tr("Changed during this read. Read again for current content.") : tr("Returned by the selected MCP server. Text is displayed as data; binary content is not opened."), fields: [field(tr("Resource URI"), 'uri', uri), field(tr("Contents"), 'contents', JSON.stringify(contents, null, 2), true)] }; render();
    }
    function resourceUri(integration, template = '', interactive=false) {
      dialog = { title: tr("Read resource URI"), notice: template ? tr("Template: {0}. Enter a complete resource URI. It is sent to this MCP server only.", (template)) : tr("Enter a complete resource URI. Wiek sends it to this MCP server and displays the returned data."), fields: [field(tr("Resource URI"), 'uri', '')], submit: values => readResource(integration, values.uri, interactive) }; render();
    }
    function reviewSignIn(item, flow) {
      dialog={title:tr("Review OAuth sign-in"),notice:tr("Authorize access to {0}. Sign-in opens in your system browser. Review the issuer and permissions there; Wiek will store the resulting tokens using OS encryption. Tool requests are not automatically retried.", (item.url)),submitLabel:flow.clientIdentity?.registration==='dynamic'&&!flow.clientIdentity.clientId ? tr('Register and open sign-in') : tr('Open sign-in page'),fields:[...(flow.clientIdentity?.endpoint?[{...field(tr('Registration endpoint'),'endpoint',flow.clientIdentity.endpoint),readonly:true}]:[]),...(flow.clientIdentity?[{...field(tr("Client identity"),'clientId',flow.clientIdentity.clientId || tr('Assigned after approval')),readonly:true},{...field(tr("Registration mechanism"),'registration',flow.clientIdentity.registration),readonly:true},...(flow.clientIdentity.clientName?[{...field(tr("Client name from metadata"),'clientName',flow.clientIdentity.clientName),readonly:true}]:[]),{...field(tr("Loopback callback"),'redirectUri',flow.clientIdentity.redirectUri),readonly:true}]:[]),{...field(tr("Authorization server"),'issuer',flow.issuer),readonly:true},{...field(tr("MCP resource"),'resource',flow.resource),readonly:true},{...field(tr("Requested permissions"),'scopes',flow.scopes.join(' ')||'(none specified)'),readonly:true}],submit:()=>action('mcp:oauth:open',{integrationId:item.id,scope:scope(),flowId:flow.id})};render();
    }
    function oauthControls(card,item) {
      if(!item.oauth)return;
      if(item.oauth.registration==='metadata')card.append(button(tr("Client metadata to host"),async()=>{const result=await action('mcp:oauth:client-document',{integrationId:item.id,scope:scope()});if(result){dialog={title:tr("Client metadata to host"),readonly:true,notice:tr("Host this public JSON at the configured HTTPS client ID URL before preparing sign-in. Wiek does not publish it. The authorization server must support CIMD and accept the exact IPv4 loopback redirect URI. Metadata text does not prove ownership or publisher identity."),fields:[field(tr("HTTPS client ID"),'clientId',item.oauth.clientId),field(tr("Public JSON document"),'document',JSON.stringify(result.document,null,2),true)]};render();}}));
      const selected=scope(),same=entry=>entry.integrationId===item.id&&entry.scope.projectId===selected.projectId&&(entry.scope.threadId||'')===(selected.threadId||'');
      const credential=data.oauth?.credentials?.find(same),flow=data.oauth?.flows?.filter(same).at(-1),actions=make('div','','vm-actions');
      if(credential)card.append(make('p',tr("Signed in with {0} · {1}{2}", (credential.issuer), (credential.scopes.join(' ') || tr('no scopes returned')), (credential.expiresAt?` · expires ${new Date(credential.expiresAt).toLocaleString(globalThis.WiekI18n?.locale())}`:'')),'vm-muted'));
      if(flow)card.append(make('p',tr("OAuth: {0}{1}", tr(flow.status), flow.error ? ' · ' + (globalThis.WiekI18n?.error(flow.error) ?? flow.error) : ''),'vm-muted'));
      const additional = data.oauth?.additionalScopes?.find(same);
      if(additional){
        card.append(make('p',tr('Additional permissions requested: {0}',additional.scopes.join(' ')),'vm-muted'));
        const review=button(tr('Review additional permissions'),async()=>{
          const result=await action('mcp:oauth:prepare',{integrationId:item.id,scope:scope(),stepUp:true});
          if(result?.status==='prepared')reviewSignIn(item,result);
        });
        review.disabled=pending||!data.oauth?.available||['discovering','prepared','authorizing','exchanging'].includes(flow?.status);
        actions.append(review);
      }
      if(!data.oauth?.available)card.append(make('p',tr("OAuth sign-in is unavailable: secure OS credential storage is required."),'vm-error'));
      if(!flow||!['discovering','prepared','authorizing','exchanging'].includes(flow.status)){const prepare=button(credential?tr("Authorize again"):tr("Prepare sign-in"),async()=>{const result=await action('mcp:oauth:prepare',{integrationId:item.id,scope:scope()});if(result?.status==='prepared')reviewSignIn(item,result)});prepare.disabled=pending||!data.oauth?.available;actions.append(prepare);}
      if(flow?.status==='prepared')actions.append(button(tr("Review sign-in"),()=>reviewSignIn(item,flow)));
      if(flow&&['discovering','prepared','authorizing','exchanging'].includes(flow.status)){const cancel=button(tr("Cancel sign-in"),async()=>{try{await invoke('mcp:oauth:cancel',{integrationId:item.id,scope:scope(),flowId:flow.id});update(await invoke('mcp:snapshot',{}))}catch(failure){error=failure.message;render()}});cancel.disabled=false;actions.append(cancel);}
      if(credential)actions.append(button(tr("Sign out"),()=>action('mcp:oauth:forget',{integrationId:item.id,scope:scope()})));card.append(actions);
    }
    function resources(card, item, connection) {
      if (connection?.status !== 'connected') return;
      if (!connection.resourceCapabilities) return;
      const section = make('details'); section.dataset.resourceKey = `${item.id}:${projectId}:${threadId}`; section.open = resourceSections.get(section.dataset.resourceKey) === true; section.append(make('summary', tr("Resources")));
      const actions = make('div', '', 'vm-actions'); actions.append(button(tr("List resources"), () => action('mcp:resources:list', { integrationId: item.id, scope: scope() })), button(tr("List templates"), () => action('mcp:resources:templates', { integrationId: item.id, scope: scope() })), button(tr("Read URI"), () => resourceUri(item))); actions.append(button(tr("Read URI with input"),()=>resourceUri(item,'',true))); section.append(actions);
      for (const resource of connection.resources || []) { const row = make('div', '', 'vm-tool'), info = make('div', '', 'vm-grow'); info.append(make('strong', resource.title || resource.name), make('p', resource.description || ''), make('code', resource.uri)); row.append(info, button(tr("Read resource"), () => readResource(item, resource.uri))); row.append(button(tr("Read with input"),()=>readResource(item,resource.uri,true))); if (connection.resourceCapabilities.subscribe === true && !(connection.resourceSubscriptions || []).some(entry => entry.uri === resource.uri)) row.append(button(tr("Subscribe"), () => action('mcp:resources:subscribe', { integrationId: item.id, scope: scope(), uri: resource.uri }))); section.append(row); }
      if (connection.resources?.length === 0) section.append(make('p', tr("No resources listed by this server."), 'vm-muted'));
      for (const template of connection.resourceTemplates || []) { const row = make('div', '', 'vm-tool'); row.append(make('span', `${template.title || template.name} · ${template.uriTemplate}`, 'vm-grow'), button(tr("Use template"), () => resourceUri(item, template.uriTemplate))); section.append(row); }
      for (const entry of connection.resourceSubscriptions || []) { const row = make('div', '', 'vm-tool'); row.append(make('span', tr("{0} · {1} · {2} · updates {3}", (entry.uri), tr(entry.status), tr(entry.revision > entry.readRevision ? 'changed — read again' : 'no unread update'), (entry.revision)), 'vm-grow'), button(tr("Read latest"), () => readResource(item, entry.uri)), button(tr("Unsubscribe"), () => action('mcp:resources:unsubscribe', { integrationId: item.id, scope: scope(), uri: entry.uri }))); if(item.protocolVersion==='2026-07-28'&& !['subscribed','subscribing','unsubscribing'].includes(entry.status))row.append(button(tr("Retry subscription"),()=>action('mcp:resources:subscribe',{integrationId:item.id,scope:scope(),uri:entry.uri}))); if(entry.error)row.append(make('span',globalThis.WiekI18n?.error(entry.error) ?? entry.error,'vm-error')); section.append(row); }
      section.append(make('p', tr("Subscriptions belong to this connection. Updates mark content stale; they do not fetch or execute it. Disconnecting clears subscriptions. Ended streams require an explicit retry; missed updates are not replayed."), 'vm-muted')); card.append(section);
    }
    function prompts(card,item,connection) {
      if(connection?.status!=='connected'||!connection.promptCapabilities)return;
      const section=make('details');section.dataset.resourceKey=`${item.id}:${projectId}:${threadId}:prompts`;section.open=resourceSections.get(section.dataset.resourceKey)===true;section.append(make('summary',tr("Prompts")),button(tr("List prompts"),()=>action('mcp:prompts:list',{integrationId:item.id,scope:scope()})));
      for(const prompt of connection.prompts||[]){const row=make('div','','vm-tool'),info=make('div','','vm-grow');info.append(make('strong',prompt.title||prompt.name),make('p',prompt.description||''));row.append(info,button(tr("Preview prompt"),()=>{dialog={title:prompt.title||prompt.name,notice:tr("Arguments are sent to this server only. Returned messages are previewed as data and are not sent to an Agent."),fields:[field(tr("Prompt arguments — JSON object of strings"),'arguments','{}',true)],submitLabel:tr("Read prompt"),submit:async values=>{let args;try{args=JSON.parse(values.arguments);}catch{throw new Error(tr("Prompt arguments must be valid JSON."));}const selected=JSON.stringify(scope()),result=await action('mcp:prompts:get',{integrationId:item.id,scope:scope(),name:prompt.name,arguments:args});if(result&&selected===JSON.stringify(scope())){dialog={title:tr("Prompt preview"),readonly:true,notice:result.stale?tr("The prompt list changed during this read. Refresh it before using these messages."):tr("Untrusted server messages. Previewing does not execute them or add them to an Agent conversation."),fields:[field(tr("Messages"),'messages',JSON.stringify(result.messages,null,2),true)]};render();}}};render();}));row.append(button(tr("Preview with input"),()=>{
        dialog={title:prompt.title||prompt.name,fields:[field(tr("Prompt arguments — JSON object of strings"),'arguments','{}',true)],submitLabel:tr("Start preview"),submit:async values=>{
          let args;try{args=JSON.parse(values.arguments);}catch{throw new Error(tr("Prompt arguments must be valid JSON."));}
          const selected=JSON.stringify(scope()),task=await action('mcp:prompts:getInteractive',{integrationId:item.id,scope:scope(),name:prompt.name,arguments:args});
          if(task&&selected===JSON.stringify(scope())){view='tasks';render();}
        }};render();
      }));section.append(row);}
      if(connection.prompts?.length===0)section.append(make('p',tr("No prompts listed by this server."),'vm-muted'));
      section.append(make('p',tr("List changes invalidate this connection’s prompt list. Refresh it explicitly; previews are not persisted."),'vm-muted'));card.append(section);
    }
    function pairClient() {
      const ids = data.integrations.filter(i => visible(i.scope)).map(i => i.id);
      dialog = { title: tr("Pair a local MCP client"), notice: tr("A one-time code grants the selected project/thread only. Exchange it locally for a bearer token; revoke the client here when finished."), fields: [field(tr("Client name"), 'name', 'Local client'), field(tr("Allowed integration IDs — JSON array"), 'integrationIds', JSON.stringify(ids), true), field(tr("Allowed browser methods — JSON array; choose only the capabilities needed"), 'browserMethods', '[]', true)], submit: async values => {
        let integrationIds, browserMethods; try { integrationIds = JSON.parse(values.integrationIds); browserMethods = JSON.parse(values.browserMethods); } catch { throw new Error(tr("Allowlists must be JSON arrays.")); }
        const result = await action('mcp:pairing:create', { scope: scope(), name: values.name, integrationIds, browserMethods });
        if (result) { dialog = { title: tr("Pairing code"), notice: tr("Expires {0}. This code is shown only in this dialog and can be exchanged once.", (new Date(result.expiresAt).toLocaleString(globalThis.WiekI18n?.locale()))), readonly: true, fields: [field(tr("One-time code"), 'code', result.code), field(tr("POST exchange endpoint"), 'exchangeUrl', result.exchangeUrl)] }; render(); }
      } }; render();
    }
    function connectionFor(id) { return data.connections.find(c => c.integrationId === id && c.scope.projectId === projectId && (c.scope.threadId || '') === threadId); }
    function integrations(body) {
      const list = data.integrations.filter(item => visible(item.scope));
      if (!list.length) body.append(make('div', tr("No MCP integrations in this scope. Add a stdio or HTTP MCP server to connect tools to this project."), 'vm-empty'));
      for (const item of list) {
        const card = make('article', '', 'vm-card'), head = make('div', '', 'vm-row'), info = make('div', '', 'vm-grow'), connection = connectionFor(item.id);
        info.append(make('h3', item.name), make('p', scopeName(item.scope)), make('code', item.transport === 'http' ? tr("HTTP · {0}", (item.url)) : [item.command, ...(item.args || [])].join(' '), 'vm-command'));
        head.append(info, make('span', tr(connection?.status || 'disconnected'), `vm-status vm-${connection?.status || 'disconnected'}`)); card.append(head);
        const actions = make('div', '', 'vm-actions');
        actions.append(button(connection?.status === 'connected' ? tr("Disconnect") : tr("Connect"), () => action(`mcp:integrations:${connection?.status === 'connected' ? 'disconnect' : 'connect'}`, { id: item.id, scope: scope() })), button(tr("List tools"), () => listTools(item)), button(tr("Configure"), () => editIntegration(item)), button(tr("Remove"), () => { dialog = { title: tr("Remove integration?"), notice: tr("Disconnect {0} and remove its configuration.", (item.name)), fields: [], submit: () => action('mcp:integrations:remove', { id: item.id }) }; render(); })); card.append(actions);
        if (connection?.error) card.append(make('div', connection.error, 'vm-error'));
        if (connection?.stderr) card.append(make('p', connection.stderr, 'vm-muted'));
        for (const tool of (item.protocolVersion==='2026-07-28'?connection?.tools:tools.get(`${item.id}:${projectId}:${threadId}`)||connection?.tools) || []) { const row = make('div', '', 'vm-tool'), description = make('div', '', 'vm-grow'); description.append(make('strong', tool.name), make('p', tool.description || tr("No description supplied"))); row.append(description, button(tr("Run tool"), () => toolCall(item, tool))); card.append(row); }
        if(item.protocolVersion==='2026-07-28'&&connection?.status==='connected'){const watch=connection.notificationStreams?.lists;card.append(make('p','List updates: '+(watch?.status||'off')+'. Refresh lists after a gap; streams do not reconnect automatically.','vm-muted'),button(watch?.status==='subscribed'?tr("Stop watching lists"):tr("Watch list changes"),()=>action(watch?.status==='subscribed'?'mcp:subscriptions:stop':'mcp:subscriptions:watch',{integrationId:item.id,scope:scope()})));if(watch?.error)card.append(make('p',watch.error,'vm-error'));}
        oauthControls(card,item);resources(card, item, connection);prompts(card,item,connection); body.append(card);
      }
    }
    async function reviewInput(task) {
      const review=task.inputReview, integration=data.integrations.find(i=>i.id===task.integrationId), fields=[], groups=[];
      const currentScope = JSON.stringify(scope());
      let addresses = new Map();
      if (review.mode) {
        const details = await action('mcp:tasks:inputUrlDetails', {id:task.id,scope:task.scope,reviewId:review.id}, {close:false});
        if (!details || currentScope !== JSON.stringify(scope()) || !data.tasks.some(row => row.id === task.id && row.inputReview?.id === review.id)) return;
        addresses = new Map(details.urls.map(row => [row.id, row.url]));
      }
      for(const [index,form] of review.forms.entries()){
        const actionKey=`action-${index}`;fields.push({label:form.message,key:actionKey,value:'accept',options:[{value:'accept',label:tr("Provide input")},{value:'decline',label:tr("Decline this input")},{value:'cancel',label:tr("Dismiss this input")}]});
        const entries=[];
        if(form.mode==='url'){
          const address={...field(form.opened?tr("Opened HTTPS site. Finish there before submitting."):tr("Requested HTTPS site"),`url-${index}`,form.origin),readonly:true};
          if (review.mode) {
            const url = addresses.get(form.id);
            fields.push({...field(tr('Full requested address'), `full-url-${index}`, url, true), readonly:true});
            if (url && new URL(url).hostname.split('.').some(label => label.startsWith('xn--'))) fields.push({...field(tr('Address contains an internationalized domain'), `domain-${index}`, form.origin),readonly:true});
          }
          fields.push(address);
          groups.push({id:form.id,actionKey,entries,address,opened:form.opened});
          continue;
        }
        for(const [key,schema] of Object.entries(form.schema.properties)){
          const fieldKey=`input-${index}-${entries.length}`,required=(form.schema.required||[]).includes(key),f={label:`${schema.title||key}${required?' (required)':''}${schema.description?' — '+schema.description:''}`,key:fieldKey,value:schema.default??'',optional:true,schema};
          const choice=value=>value.enum?.map(v=>({value:v,label:v}))||(value.oneOf||value.anyOf)?.map(v=>({value:v.const,label:v.title}));
          if(schema.type==='boolean'){f.options=[{value:'',label:tr("Choose…")},{value:'true',label:tr("True")},{value:'false',label:tr("False")}];f.value=schema.default===undefined?'':String(schema.default);}
          else if(schema.type==='array'){f.options=choice(schema.items);f.multiple=true;f.value=schema.default||[];}
          else if(choice(schema)){f.options=[{value:'',label:tr("Choose…")},...choice(schema)];}
          if(['integer','number'].includes(schema.type))f.inputType='number';
          fields.push(f);entries.push({key,fieldKey,schema,required});
        }
        groups.push({id:form.id,actionKey,entries});
      }
      const payload=responses=>({id:task.id,scope:task.scope,reviewId:review.id,responses});
      dialog={title:tr("Review requested input"),taskId:task.id,reviewId:review.id,submitLabel:review.mode==='retry'?tr('Retry after finishing on the website'):tr("Submit reviewed inputs"),notice:tr("{0} · {1}\n{2}: {3} · Scope: {4} · Round {5} · Expires {6}. Inputs go to this server. Do not enter passwords, API keys or payment credentials. Submitted values and interactive results are kept only for this running app session.", (integration?.name||task.integrationId), (integration?.url||''), (task.kind==='resource'?'Resource':task.kind==='prompt'?'Prompt':'Tool'), (task.name), (scopeName(task.scope)), (review.round), (new Date(review.expiresAt).toLocaleString(globalThis.WiekI18n?.locale()))),fields,
        extraActions:[...groups.filter(g=>g.address&&!g.opened).map(g=>({label:tr("Open requested address"),run:async()=>{const active=dialog;if(await action('mcp:tasks:openInputUrl',{...payload(),inputId:g.id},{close:false})&&dialog===active){g.address.label=tr("Opened HTTPS site. Finish there before submitting.");g.opened=true;render();}},available:()=>!g.opened})),{label:tr("Decline all"),run:()=>action('mcp:tasks:respond',payload(Object.fromEntries(groups.map(g=>[g.id,{action:'decline'}]))))},{label:tr("Cancel task"),run:()=>action('mcp:tasks:cancel',{id:task.id,scope:task.scope})}],
        submit:values=>{const responses=Object.fromEntries(groups.map(g=>{const selected=values[g.actionKey];if(selected!=='accept'||g.address)return[g.id,{action:selected}];const content=Object.fromEntries(g.entries.flatMap(f=>{let value=values[f.fieldKey];if(value===''&&!f.required||f.schema.type==='array'&&!value.length&&!f.required)return[];if(f.schema.type==='boolean')value=value==='true'?true:value==='false'?false:undefined;else if(['number','integer'].includes(f.schema.type))value=value===''?undefined:Number(value);return[[f.key,value]];}));return[g.id,{action:'accept',content}];}));return action('mcp:tasks:respond',payload(responses));}};render();
    }
    function tasks(body) {
      const list = [...data.tasks].reverse().filter(t => t.scope.projectId === projectId && (!threadId || t.scope.threadId === threadId));
      if (!list.length) body.append(make('div', tr("Tool calls and interactive reads appear here."), 'vm-empty'));
      for (const task of list) {
        const card = make('article', '', 'vm-card'), row = make('div', '', 'vm-row'), info = make('div', '', 'vm-grow');
        info.append(make('h3', task.name), make('p', `${scopeName(task.scope)} · ${new Date(task.createdAt).toLocaleString(globalThis.WiekI18n?.locale())}`)); row.append(info, make('span', tr(task.status), `vm-status vm-${task.status}`));
        if(task.inputReview)row.append(button(tr("Review input"),()=>reviewInput(task)));
        if (['queued', 'running','awaiting_input'].includes(task.status)) row.append(button(tr("Cancel"), () => action('mcp:tasks:cancel', { id: task.id, scope: task.scope })));
        card.append(row); if(task.resultRetained===false)card.append(make('p',tr("Interactive results are not saved in task history."),'vm-muted')); if (task.error) card.append(make('div', task.error, 'vm-error'));
        if (task.result !== undefined) { const details = make('details'); details.append(make('summary',task.kind==='resource'?tr("Resource contents"):task.kind==='prompt'?tr("Prompt preview"):tr("Tool result")), make('pre', JSON.stringify(task.result,(key,value)=>task.kind==='resource'&&key==='blob'&&typeof value==='string'?{binaryBase64Characters:value.length}:value,2), 'vm-result')); card.append(details); } body.append(card);
      }
    }
    function clients(body) {
      body.append(make('p', data.gateway ? tr("Local gateway: {0}/mcp", (data.gateway.url)) : tr("Start pairing to create the local loopback gateway."), 'vm-muted'));
      const list = data.grants.filter(g => g.scope.projectId === projectId && (!threadId || g.scope.threadId === threadId));
      if (!list.length) body.append(make('div', tr("No paired clients in this scope."), 'vm-empty'));
      for (const grant of list) { const card = make('article', '', 'vm-card'), row = make('div', '', 'vm-row'), info = make('div', '', 'vm-grow'); info.append(make('h3', grant.name), make('p', scopeName(grant.scope)), make('p', tr("Expires {0} · {1} integrations · {2}", (new Date(grant.expiresAt).toLocaleString(globalThis.WiekI18n?.locale())), (grant.integrationIds.length), (grant.browserMethods.join(', ') || 'no browser access')))); row.append(info, grant.revokedAt ? make('span', tr("revoked"), 'vm-status') : button(tr("Revoke"), () => action('mcp:grants:revoke', { id: grant.id }))); card.append(row); body.append(card); }
    }
    function dialogNode() {
      const overlay = make('div', '', 'vm-overlay'), form = make('form', '', 'vm-dialog'); form.setAttribute('role', 'dialog'); form.setAttribute('aria-modal', 'true'); form.append(make('h2', dialog.title), make('p', dialog.notice || ''));
      for (const f of dialog.fields || []) { const label = make('label', f.label), input = make(f.options?'select':f.multiline ? 'textarea' : 'input');
        if(f.options){input.multiple=!!f.multiple;for(const o of f.options){const option=make('option',o.label);option.value=o.value;option.selected=f.multiple?f.value.includes(o.value):String(f.value)===o.value;input.append(option);}}else{input.value=f.value;if(f.inputType){input.type=f.inputType;input.step=f.schema?.type==='integer'?'1':'any';}}
        input.name = f.key; input.readOnly = Boolean(dialog.readonly||f.readonly); input.required = !dialog.readonly&&!f.optional&&!dialog.reviewId; input.dataset.focus = f.key; input.oninput = () => { f.value = f.multiple?[...input.selectedOptions].map(o=>o.value):input.value; }; label.append(input); form.append(label); }
      if (error) form.append(make('div', (globalThis.WiekI18n?.error(error) ?? (error)), 'vm-error'));
      const buttons = make('div', '', 'vm-actions'); buttons.append(button(dialog.readonly ? tr("Done") : tr("Cancel"), () => { dialog = null; error = ''; render(); }));
      for(const extra of dialog.extraActions||[])if(!extra.available||extra.available())buttons.append(button(extra.label,extra.run));
      if (!dialog.readonly) { const submit = make('button', pending ? tr("Working…") : dialog.submitLabel||tr("Save / continue"), 'vm-button vm-primary'); submit.type = 'submit'; submit.disabled = pending; buttons.append(submit); }
      form.append(buttons); form.onsubmit = async event => { event.preventDefault(); error = ''; try { await dialog.submit(Object.fromEntries(dialog.fields.map(f => [f.key, f.value]))); } catch (failure) { error = failure.message; render(); } }; overlay.append(form); return overlay;
    }
    function render() {
    if (globalThis.WiekI18n?.deferWhileComposing(root, render)) return;
      if (destroyed) return;
      for(const section of root.querySelectorAll('details[data-resource-key]'))resourceSections.set(section.dataset.resourceKey,section.open);
      const active = root.contains(document.activeElement) ? document.activeElement : null, focused = active?.dataset.focus, selection = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
      root.classList.add('vek-mcp-panel'); root.replaceChildren();
      const header = make('div', '', 'vm-header'), intro = make('div'); intro.append(make('h1', tr("Connected tools")), make('p', tr("MCP servers over stdio or HTTP, scoped tool tasks, and paired clients."))); header.append(intro, button(tr("Add MCP server"), () => editIntegration(), 'vm-primary'), button(tr("Add HTTP server"), () => editIntegration(null, 'http'))); root.append(header);
      const selectors = make('div', '', 'vm-selectors'), project = make('select'), thread = make('select'); project.setAttribute('aria-label', tr("Project scope")); thread.setAttribute('aria-label', tr("Thread scope"));
      for (const p of context.projects || []) { const option = make('option', p.name); option.value = p.id; option.selected = p.id === projectId; project.append(option); }
      const all = make('option', tr("All threads in project")); all.value = ''; thread.append(all);
      for (const t of (context.threads || []).filter(t => t.projectId === projectId)) { const option = make('option', t.title || t.id); option.value = t.id; option.selected = t.id === threadId; thread.append(option); }
      project.disabled = pending; thread.disabled = pending;
      project.onchange = () => { projectId = project.value; threadId = ''; dialog = null; render(); }; thread.onchange = () => { threadId = thread.value; dialog = null; render(); };
      selectors.append(make('span', tr("Scope")), project, thread, button(tr("Refresh"), () => action('mcp:snapshot', {}))); root.append(selectors);
      const tabs = make('nav', '', 'vm-tabs'); for (const [id, label] of [['integrations', tr("Integrations")], ['tasks', tr("Tool tasks")], ['clients', tr("Paired clients")]]) tabs.append(button(label, () => { view = id; render(); }, view === id ? 'is-active' : '')); root.append(tabs);
      if (error && !dialog) root.append(make('div', (globalThis.WiekI18n?.error(error) ?? (error)), 'vm-error'));
      const body = make('section', '', 'vm-body');
      if (!projectId) body.append(make('div', tr("Add a project in the agent workspace before configuring scoped integrations."), 'vm-empty'));
      else if (view === 'integrations') integrations(body); else if (view === 'tasks') tasks(body); else { body.append(button(tr("Pair a local client"), pairClient, 'vm-primary')); clients(body); }
      root.append(body); if (dialog) root.append(dialogNode());
      if (focused) { const input = [...root.querySelectorAll('[data-focus]')].find(n => n.dataset.focus === focused); input?.focus({ preventScroll: true }); try { if (selection) input?.setSelectionRange(...selection); } catch {} }
    }
    render(); return { update, destroy() { destroyed = true; dialog = null; tools.clear(); root.replaceChildren(); root.classList.remove('vek-mcp-panel'); } };
  }
  let mounted;
  window.createWiekMcpPanel = createPanel;
  window.WiekMcpPanel = { mount(root, invoke, context) { mounted?.destroy(); mounted = createPanel(root, invoke, context); return mounted; }, update(next, context) { mounted?.update(next, context); }, destroy() { mounted?.destroy(); mounted = null; } };
})();
