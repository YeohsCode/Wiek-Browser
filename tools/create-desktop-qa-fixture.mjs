import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
if(process.platform!=='darwin')throw new Error('Native desktop QA fixture requires macOS');
const root=resolve(import.meta.dirname,'..'),destination=resolve(process.argv[2]||join(root,'data/Wiek Native Fixture.app'));
if(existsSync(destination))throw new Error('Choose a new fixture output directory');
mkdirSync(resolve(destination,'..'),{recursive:true});
// Clone the installed official Electron distribution, including its framework
// symlinks. Never point a deep codesign operation at external framework links.
execFileSync('/bin/cp',['-R','-c',join(root,'node_modules/electron/dist/Electron.app'),destination]);
const plist=join(destination,'Contents/Info.plist');
execFileSync('/usr/libexec/PlistBuddy',['-c','Set :CFBundleIdentifier app.wiek.desktop.fixture',plist]);
execFileSync('/usr/libexec/PlistBuddy',['-c','Set :CFBundleName Wiek Native Fixture',plist]);
const directory=join(destination,'Contents/Resources/app');mkdirSync(directory,{recursive:true});
writeFileSync(join(directory,'package.json'),JSON.stringify({name:'wiek-native-qa-fixture',main:'main.cjs'}));
writeFileSync(join(directory,'main.cjs'),'require('+JSON.stringify(join(root,'tests/fixtures/desktop-native-interactive.cjs'))+');\n');
execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',destination],{stdio:'inherit'});
console.log(destination);
