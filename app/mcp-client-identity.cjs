'use strict';
// Public-client identity only.
const fail = message => Object.assign(new Error(message), { error_code: 'VEK_MCP_OAUTH' });
function metadataClientId(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || Buffer.byteLength(value) > 2048 || /[\x00-\x20\x7f\\?#]/.test(value)) throw fail('CIMD client ID must be a canonical HTTPS document URL without query or fragment');
  let parsed; try { parsed = new URL(value); } catch { throw fail('Invalid CIMD document URL'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname === '/' || parsed.href !== value) throw fail('CIMD client ID requires a canonical HTTPS URL with a non-root path');
  const rawPath = value.slice(value.indexOf('/', 'https://'.length));
  try { if (rawPath.split('/').some(segment => ['.', '..'].includes(decodeURIComponent(segment)) || /[\\/]/.test(decodeURIComponent(segment)))) throw Error(); }
  catch { throw fail('CIMD client ID cannot contain dot segments or encoded path separators'); }
  return parsed;
}
function normalizeIdentity(value) {
  if (value.registration !== undefined && !['preregistered', 'metadata', 'dynamic'].includes(value.registration)) throw fail('OAuth registration must be preregistered, metadata or dynamic');
  if (value.registration === 'metadata') {
    metadataClientId(value.clientId);
    if (!Number.isInteger(value.redirectPort) || value.redirectPort < 1024 || value.redirectPort > 65535) throw fail('CIMD requires a fixed loopback redirect port between 1024 and 65535');
  }
  if (value.registration === 'dynamic') {
    if (value.clientId !== undefined || !value.issuer) throw fail('Dynamic registration requires an expected issuer and no configured client ID');
    if (!Number.isInteger(value.redirectPort) || value.redirectPort < 1024 || value.redirectPort > 65535) throw fail('Dynamic registration requires a fixed loopback port between 1024 and 65535');
  }
  if (value.issuer !== undefined) {
    let parsed; try { parsed = new URL(value.issuer); } catch { throw fail('Invalid expected OAuth issuer'); }
    if (typeof value.issuer !== 'string' || !value.issuer.isWellFormed() || Buffer.byteLength(value.issuer) > 16384 || /[\x00-\x20\x7f\\?#]/.test(value.issuer) || parsed.username || parsed.password || !['https:', 'http:'].includes(parsed.protocol)) throw fail('Invalid expected OAuth issuer');
  }
  return { ...(value.registration && value.registration !== 'preregistered' ? { registration: value.registration } : {}), ...(value.issuer === undefined ? {} : { issuer: value.issuer }) };
}
const callbackUri = oauth => `http://127.0.0.1:${oauth.redirectPort}/oauth/callback`;
function createClientDocument(oauth) {
  if (oauth?.registration !== 'metadata') throw fail('Choose metadata registration before preparing a client document');
  normalizeIdentity(oauth);
  return { client_id: oauth.clientId, client_name: 'Wiek Browser', redirect_uris: [callbackUri(oauth)], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'native' };
}
function validateClientDocument(data, oauth) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Buffer.byteLength(JSON.stringify(data)) > 5120) throw fail('CIMD document must be a JSON object of at most 5 KiB');
  if (data.client_id !== oauth.clientId) throw fail('CIMD document client_id must match the configured URL exactly');
  if (typeof data.client_name !== 'string' || !data.client_name.trim() || !data.client_name.isWellFormed() || Buffer.byteLength(data.client_name) > 256 || /[\x00-\x1f\x7f]/.test(data.client_name)) throw fail('Invalid CIMD client name');
  if (Object.hasOwn(data, 'client_secret') || Object.hasOwn(data, 'client_secret_expires_at') || data.token_endpoint_auth_method !== 'none') throw fail('CIMD requires a public client with explicit token_endpoint_auth_method none and no shared secret');
  for (const [key, required] of [['grant_types', 'authorization_code'], ['response_types', 'code']]) if (!Array.isArray(data[key]) || data[key].length > 16 || !data[key].includes(required) || data[key].some(v => typeof v !== 'string' || v.length > 128)) throw fail('CIMD must explicitly support authorization-code responses and grants');
  if (!Array.isArray(data.redirect_uris) || data.redirect_uris.length > 16 || data.redirect_uris.some(v => typeof v !== 'string' || v.length > 2048 || /[\x00-\x20\x7f]/.test(v)) || !data.redirect_uris.includes(callbackUri(oauth))) throw fail('CIMD redirect_uris must include the exact configured IPv4 loopback callback');
  return { registration: 'metadata', clientId: oauth.clientId, clientName: data.client_name, redirectUri: callbackUri(oauth) };
}
async function resolveClientIdentity(config, meta, signal, fetchDocument) {
  const oauth = config.oauth;
  if (oauth.issuer !== undefined && oauth.issuer !== meta.issuer) throw fail('Discovered authorization server does not match the expected issuer');
  if (oauth.registration === 'dynamic') {
    if (!meta.registrationEndpoint) throw fail('The expected issuer does not advertise a same-origin registration endpoint');
    return { registration: 'dynamic', redirectUri: callbackUri(oauth), endpoint: meta.registrationEndpoint };
  }
  if (oauth.registration !== 'metadata') return { registration: 'preregistered', clientId: oauth.clientId };
  if (meta.clientIdMetadataDocumentSupported !== true) throw fail('Authorization server does not advertise Client ID Metadata Documents; no automatic registration fallback');
  const result = await fetchDocument(metadataClientId(oauth.clientId), { signal, maxBytes: 5120, acceptJsonSuffix: true });
  if (result.status !== 200) throw fail(`CIMD document fetch failed (HTTP ${result.status}); redirects and registration fallbacks are not followed`);
  return validateClientDocument(result.data, oauth);
}
async function registerPublicClient(identity, signal, request) {
  const metadata = { client_name: 'Wiek Browser', redirect_uris: [identity.redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'native' };
  const result = await request(new URL(identity.endpoint), { method: 'POST', body: JSON.stringify(metadata), contentType: 'application/json', signal });
  if (result.status !== 201) throw fail('Dynamic client registration failed');
  const registered = result.data;
  if (typeof registered.client_id !== 'string' || !/^[!-~]{1,2048}$/.test(registered.client_id) ||
      registered.token_endpoint_auth_method !== 'none' || Object.hasOwn(registered, 'client_secret') ||
      !Array.isArray(registered.redirect_uris) || registered.redirect_uris.length !== 1 || registered.redirect_uris[0] !== identity.redirectUri ||
      !Array.isArray(registered.grant_types) || !registered.grant_types.includes('authorization_code') ||
      !Array.isArray(registered.response_types) || !registered.response_types.includes('code')) throw fail('Dynamic registration returned incompatible public client metadata');
  return registered.client_id;
}
module.exports = { registerPublicClient, metadataClientId, normalizeIdentity, createClientDocument, validateClientDocument, resolveClientIdentity };
