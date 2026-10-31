# Vek portable encrypted profile archive v1

Independent implementation in `app/profile-archive.cjs`. This is a new Vek format; compatibility with Ego's unknown profile export format is not claimed. The module performs no filesystem, network, profile discovery or Keychain operations and logs no data.

## Exact API

```js
const { createProfileArchive } = require('./profile-archive.cjs');
const archive = createProfileArchive({ maxBytes: 32 * 1024 * 1024 });
const normalized = archive.validate(payload); // synchronous independent JSON clone
const encryptedJson = await archive.encode(payload, passphrase, { expiresAt: null });
// expiresAt optionally accepts a future canonical ISO timestamp.
const { payload: restored, metadata } = await archive.decode(encryptedJson, passphrase);
// decode also accepts Buffer / Uint8Array UTF-8 bytes.
```

`archive.limits` exposes `{maxBytes,maxRowsPerCategory:20000,maxSpaces:512,maxTabs:10000,mimeType,format,version}`. Size limits apply to both plaintext JSON and final encrypted file. Base64 overhead means a 32 MiB file limit supports approximately 24 MiB of data, less envelope overhead. Limits above 128 MiB or below 512 bytes are rejected.

Payload has exactly these allowed top-level fields; only `profile` is required, omitted arrays become empty:

```js
{
 profile: { name: 'Portable profile', id: 'optional old ID' },
 spaces: [{ name:'Research', pinned:true, activeTabIndex:0,
            tabs:[{url:'https://example.com/',title:'Optional title'}] }],
 bookmarks:[{url:'https://example.com/',title:'Optional',folder:'Optional'}],
 history:[{url:'https://example.com/',title:'Optional',at:'2026-10-30T00:00:00.000Z'}],
 cookies:[{domain:'.example.com',name:'session',value:'secret',path:'/',
           secure:true,httpOnly:true,hostOnly:false,session:true,sameSite:'lax'}],
 passwords:[{origin:'https://example.com',username:'user',password:'secret'}],
 extensionsMetadata:[{id:'extension identifier',name:'Extension',version:'1.0',enabled:false}]
}
```

All nested fields are allowlisted. Tabs support only HTTP(S) and exact `about:blank`; bookmarks/history only HTTP(S). URLs containing credentials, control characters or backslashes are rejected. Password origins must be exact canonical HTTP(S) origins without trailing slash, path, query, fragment or credentials. No executable extension code, local paths, arbitrary MIME/binary payload, permissions, runtime target IDs or Space ownership are accepted. New profile/Space/tab identities and user ownership must be created by the host.

Cookie schema accepts `url`, `domain`, `name`, `value`, `path`, `secure`, `httpOnly`, `hostOnly`, `session`, `sameSite`, `expirationDate`; name/value required, and at least domain or URL required. Domain/host-only flags are normalized. Explicit URL must match domain exactly and cannot be HTTP for a Secure cookie. Persistent cookies require a finite positive expirationDate; session cookies cannot carry one. sameSite permits Electron's `unspecified`, `no_restriction`, `lax`, `strict`. Output includes canonical cookie URL/domain/path and inferred session/hostOnly flags. Host import should omit `domain` for host-only cookies and remove get-only fields before `session.cookies.set`. Expired cookies may be reported/skipped by Chromium on application; archive expiry is separate. Partitioned cookie metadata is unsupported and must not be silently converted to an unpartitioned cookie.

## Encryption and validation

Envelope: `{format:'vek-browser-profile',mimeType:'application/vnd.vek.profile+json',version:1,createdAt,expiresAt,kdf:'scrypt-131072-8-1',cipher:'aes-256-gcm',salt,iv,tag,data}`. Binary fields are strict canonical base64. Every encoding uses random 16-byte salt and 12-byte IV. The derived 32-byte key uses fixed asynchronous scrypt N=131072, r=8, p=1 (256 MiB allocation ceiling); no attacker-provided KDF tuning is accepted. AES-256-GCM uses a 16-byte tag and canonical semantic header as AAD, including version, dates, algorithms, salt and IV. Whitespace and envelope key ordering are immaterial. Unknown format/version/algorithms fail explicitly. No plaintext profile name/category counts appear in the envelope.

Passphrases require at least eight Unicode characters and at most 1024 UTF-8 bytes. They are not normalized, so exact input matters. Incorrect passphrase and authentication tampering share `VEK_PROFILE_ARCHIVE_AUTH`; no decrypted payload is released before authentication. Authenticated expired archives produce `VEK_PROFILE_ARCHIVE_EXPIRED`; default expiresAt is null. Future creation dates beyond five minutes are rejected. At most two concurrent key derivations run in this process; extra calls fail with `VEK_PROFILE_ARCHIVE_BUSY` for the host to retry.

JSON input rejects pollution keys at any depth, accessors, functions, symbols, class instances, sparse/custom-property arrays, nonfinite numbers, unpaired Unicode surrogates, unknown fields, excessive nesting/structural count and size. UTF-8 decoding is fatal on malformed bytes. No deserialization or automatic execution occurs.

Key, passphrase-byte and plaintext-byte buffers are zeroed on completion/failure. JavaScript strings and caller-owned payloads remain managed by the runtime; guaranteed memory erasure is not claimed. Only return values contain plaintext. The host must avoid including them in logs, snapshots or generic debug responses.

## Host integration

Use native selection/save dialogs and a trusted passphrase modal; write only the returned encrypted JSON, with mode 0600, never a plaintext staging file. Before export, select only the chosen Vek profile's data and explicitly chosen optional cookie/password categories. Obtain passwords only from that profile's own vault after user export authorization. No scanning/decrypting other applications is performed by this module.

Before import, stat and limit the selected file, decode/authenticate/validate, then create a new Vek profile and new user-owned Spaces. Apply cookies and re-encrypt password rows using the destination local vault. Extension metadata is an inventory only; do not automatically load local extension paths or download code. Report skipped/unsupported entries. Chromium LevelDB/IndexedDB, localStorage, service workers, caches, extension files, site permissions and OS-specific browser profile internals are outside this portable schema.

## Verification

`node --test tests/profile-archive.test.mjs`: **7/7 pass**, `reports/profile-archive-test.log`. Tests use temporary files and synthetic data: all-category ciphertext roundtrip; random salt/IV; no plaintext strings on disk; wrong password; salt/IV/tag/ciphertext and timestamp tampering; expired/unknown version/KDF/MIME; pollution/accessor and bad types; unsafe URLs/cookie mismatches/origins; file/payload/row/depth limits; concurrent independent decoding. No personal browser directory or Keychain is read.

Primary crypto reference checked: [Node.js crypto API](https://nodejs.org/api/crypto.html), specifically [scrypt](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback), [GCM AAD](https://nodejs.org/api/crypto.html#ciphersetaadbuffer-options) and [authentication tags](https://nodejs.org/api/crypto.html#deciphersetauthtagbuffer-encoding).
