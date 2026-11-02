'use strict';
// Public MCP resources, kept in connection memory. URI strings are identifiers;
// this client never opens a URI, reads a local path, or executes resource text.
const fail = (message, code = 'VEK_MCP_PROTOCOL_ERROR') => Object.assign(new Error(message), { error_code: code });
const MAX_ITEMS = 2000, MAX_BYTES = 2 * 1024 * 1024;
function text(value, label, max = 4096) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > max || /[\x00-\x1f\x7f]/.test(value)) throw fail(`Invalid MCP resource ${label}`);
  return value;
}
function uri(value) { text(value, 'URI', 16384); if (/\s/.test(value) || !/^[a-z][a-z0-9+.-]*:/i.test(value)) throw fail('Invalid MCP resource URI'); return value; }
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Invalid MCP resource response'); return value; }
function descriptor(row, template) {
  object(row); const out = template ? { uriTemplate: uri(row.uriTemplate) } : { uri: uri(row.uri) };
  out.name = text(row.name, 'name');
  for (const key of ['title', 'description', 'mimeType']) if (row[key] !== undefined) { if (typeof row[key] !== 'string' || Buffer.byteLength(row[key]) > 16384) throw fail('Invalid MCP resource metadata'); out[key] = row[key]; }
  if (row.size !== undefined) { if (!Number.isSafeInteger(row.size) || row.size < 0) throw fail('Invalid MCP resource size'); out.size = row.size; }
  return out;
}
function resetResources(client) { client.resourceListRevision = (client.resourceListRevision || 0) + 1; client.resources = null; client.resourceTemplates = null; client.resourceSubscriptions = new Map(); client.resourceOperations = new Set(); }
function capability(client, subscribe = false) {
  if (client.state !== 'connected' || client.stopped) throw fail('MCP connection is disconnected', 'VEK_MCP_DISCONNECTED');
  if (!client.info?.capabilities?.resources || typeof client.info.capabilities.resources !== 'object' || Array.isArray(client.info.capabilities.resources) || subscribe && client.info.capabilities.resources.subscribe !== true) throw fail(subscribe ? 'MCP server does not advertise resource subscriptions' : 'MCP server does not advertise resources', 'VEK_MCP_UNSUPPORTED_CAPABILITY');
}
function resourceNotification(client, message, authorizedStream = false) {
  if (client.modern && !authorizedStream) return message.method.startsWith('notifications/resources/');
  if (message.method === 'notifications/resources/list_changed') {
    if (client.info?.capabilities?.resources?.listChanged === true) { client.resourceListRevision++; client.resources = null; client.resourceTemplates = null; client.notifyChange(); }
    return true;
  }
  if (message.method !== 'notifications/resources/updated') return false;
  if (client.info?.capabilities?.resources?.subscribe !== true) return true;
  const subscription = client.resourceSubscriptions.get(message.params?.uri);
  if (subscription) { subscription.revision = Math.min(Number.MAX_SAFE_INTEGER, subscription.revision + 1); subscription.updatedAt = new Date().toISOString(); client.notifyChange(); }
  return true;
}
const methods = {
  async listResources({ signal, templates = false } = {}) {
    capability(this); const cache = templates ? 'resourceTemplates' : 'resources', field = templates ? 'resourceTemplates' : 'resources';
    if (!this.modern && this[cache]) return this[cache];
    const rows = [], ids = new Set(), cursors = new Set(), generation = this.resourceSubscriptions, listRevision = this.resourceListRevision; let cursor;
    for (let page = 0; page < 50; page++) {
      const result = object(await this.request(templates ? 'resources/templates/list' : 'resources/list', cursor === undefined ? {} : { cursor }, { signal }));
      if (!Array.isArray(result[field])) throw fail('Invalid MCP resource list');
      for (const item of result[field]) { const row = descriptor(item, templates), id = row.uri ?? row.uriTemplate; if (ids.has(id)) throw fail('Duplicate MCP resource identifier'); ids.add(id); rows.push(row); }
      if (rows.length > MAX_ITEMS || Buffer.byteLength(JSON.stringify(rows)) > MAX_BYTES) throw fail('MCP resource list exceeds limits');
      if (result.nextCursor === undefined) { if (this.state !== 'connected' || generation !== this.resourceSubscriptions || listRevision !== this.resourceListRevision) throw fail('MCP connection or resource list changed during listing; refresh again'); this[cache] = rows; this.notifyChange(); return rows; }
      cursor = text(result.nextCursor, 'cursor'); if (cursors.has(cursor)) throw fail('Repeated MCP resource cursor'); cursors.add(cursor);
    }
    throw fail('MCP resources pagination exceeded the limit');
  },
  async readResource(value, { signal } = {}) {
    capability(this); uri(value); const subscription = this.resourceSubscriptions.get(value), revision = subscription?.revision, generation = this.resourceSubscriptions;
    const result = object(await this.request('resources/read', { uri: value }, { signal }));
    if (this.state !== 'connected' || generation !== this.resourceSubscriptions) throw fail('MCP connection changed during resource read');
    if (!Array.isArray(result.contents) || !result.contents.length || result.contents.length > 100 || Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw fail('Invalid or oversized MCP resource contents');
    const contents = result.contents.map(item => {
      object(item); const row = { uri: uri(item.uri) };
      if (item.mimeType !== undefined) row.mimeType = text(item.mimeType, 'MIME type');
      if (Number(Object.hasOwn(item, 'text')) + Number(Object.hasOwn(item, 'blob')) !== 1) throw fail('MCP resource must contain either text or a blob');
      if (Object.hasOwn(item, 'text')) { if (typeof item.text !== 'string') throw fail('Invalid MCP resource text'); row.text = item.text; }
      else { if (typeof item.blob !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.blob) || Buffer.from(item.blob, 'base64').toString('base64') !== item.blob) throw fail('Invalid MCP resource blob'); row.blob = item.blob; }
      return row;
    });
    if (subscription && this.resourceSubscriptions.get(value) === subscription) { subscription.readRevision = revision; this.notifyChange(); }
    return { contents, ...(revision === undefined ? {} : { revision, stale: subscription.revision !== revision }) };
  },
  async setResourceSubscription(value, enabled, { signal } = {}) {
    if (this.modern) return this.changeModernResourceSubscription(value, enabled, { signal });
    capability(this, true); uri(value);
    if (this.resourceOperations.has(value)) throw fail('This resource subscription is already changing', 'VEK_MCP_BUSY');
    const previous = this.resourceSubscriptions.get(value);
    if (enabled && previous?.status === 'subscribed') return { ...previous };
    if (!enabled && !previous) return { uri: value, status: 'unsubscribed' };
    if (enabled && !previous && this.resourceSubscriptions.size >= 128) throw fail('MCP resource subscription limit reached', 'VEK_MCP_CAPACITY');
    const item = previous || { uri: value, revision: 0, readRevision: 0 };
    const generation = this.resourceSubscriptions;
    item.status = enabled ? 'subscribing' : 'unsubscribing'; generation.set(value, item); this.resourceOperations.add(value); this.notifyChange();
    try {
      const result = await this.request(enabled ? 'resources/subscribe' : 'resources/unsubscribe', { uri: value }, { signal }); object(result);
      if (this.state !== 'connected' || generation !== this.resourceSubscriptions) throw fail('MCP connection changed during subscription');
      if (enabled) item.status = 'subscribed'; else { generation.delete(value); item.status = 'unsubscribed'; }
      return { ...item };
    } catch (error) { if (this.resourceSubscriptions === generation && generation.has(value)) item.status = 'unknown'; throw error; }
    finally { if (this.resourceSubscriptions === generation) this.resourceOperations.delete(value); this.notifyChange(); }
  },
};
module.exports = { methods, resetResources, resourceNotification, uri, capability };
