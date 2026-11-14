import {execFileSync} from 'node:child_process';
import {mkdirSync,chmodSync} from 'node:fs';
import {resolve} from 'node:path';
if(process.platform!=='darwin')throw new Error('The selection helper build requires macOS');
const root=resolve(import.meta.dirname,'..'),out=resolve(root,'app/bin/vek-selection');mkdirSync(resolve(root,'app/bin'),{recursive:true});
execFileSync('/usr/bin/xcrun',['swiftc','-O','-target','arm64-apple-macosx12.0','-framework','AppKit','-framework','ApplicationServices',resolve(root,'tools/native/selection.swift'),'-o',out],{stdio:'inherit'});chmodSync(out,0o755);console.log(out);

const monitor=resolve(root,'app/bin/vek-desktop-monitor');execFileSync('/usr/bin/xcrun',['swiftc','-O','-target','arm64-apple-macosx12.0','-framework','AppKit','-framework','ApplicationServices',resolve(root,'tools/native/desktop-monitor.swift'),'-o',monitor],{stdio:'inherit'});chmodSync(monitor,0o755);console.log(monitor);

const processes=resolve(root,'app/bin/wiek-process-info');execFileSync('/usr/bin/xcrun',['swiftc','-O','-target','arm64-apple-macosx12.0',resolve(root,'tools/native/local-server-processes.swift'),'-o',processes],{stdio:'inherit'});chmodSync(processes,0o755);console.log(processes);

const semantic = resolve(root, 'app/bin/wiek-saved-text-search');
execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-target', 'arm64-apple-macosx12.0', '-framework', 'NaturalLanguage', resolve(root, 'tools/native/saved-text-search.swift'), '-o', semantic], {stdio:'inherit'});
chmodSync(semantic, 0o755);
console.log(semantic);
