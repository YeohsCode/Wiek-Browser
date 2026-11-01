import {execFileSync} from 'node:child_process';
import {mkdirSync,chmodSync} from 'node:fs';
import {resolve} from 'node:path';
if(process.platform!=='darwin')throw new Error('The selection helper build requires macOS');
const root=resolve(import.meta.dirname,'..'),out=resolve(root,'app/bin/vek-selection');mkdirSync(resolve(root,'app/bin'),{recursive:true});
execFileSync('/usr/bin/xcrun',['swiftc','-O','-target','arm64-apple-macosx12.0','-framework','AppKit','-framework','ApplicationServices',resolve(root,'tools/native/selection.swift'),'-o',out],{stdio:'inherit'});chmodSync(out,0o755);console.log(out);
