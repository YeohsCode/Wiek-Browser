import {spawn} from 'node:child_process';
import {mkdir,writeFile,lstat} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
export function translationPairs(value='en-zh,zh-en'){
  if(typeof value!=='string'||value.length>512)throw new Error('Specify comma-separated language pairs such as en-zh,zh-en,en-es,es-en');
  const pairs=value.split(',');
  if(!pairs.length||pairs.length>20||pairs.some(pair=>!/^([a-z]{2,3})-([a-z]{2,3})$/.test(pair)||pair.split('-')[0]===pair.split('-')[1])||new Set(pairs).size!==pairs.length)throw new Error('Choose 1–20 distinct source-target language pairs');
  return pairs;
}
export async function installOfflineTranslation({dataDir,python,root,pairs='en-zh,zh-en'}){
  const selected=translationPairs(pairs);
  if(!isAbsolute(python)||python.includes('\0'))throw new Error('Specify an absolute Python 3.12 executable path');
  async function run(command,args,env=process.env){await new Promise((ok,no)=>{const child=spawn(command,args,{shell:false,stdio:'inherit',env});child.once('error',no);child.once('close',code=>code===0?ok():no(new Error('Translation installation failed: '+code)));});}
  await mkdir(dataDir,{recursive:true,mode:0o700});
  for(const directory of [join(dataDir,'translation-runtime'),join(dataDir,'translation')]){try{const st=await lstat(directory);if(st.isSymbolicLink()||!st.isDirectory())throw new Error('Invalid translation installation directory');}catch(error){if(error.code!=='ENOENT')throw error;}}
  const environment=join(dataDir,'translation-runtime'),executable=join(environment,'bin/python');
  await run(python,['-m','venv',environment]);await run(executable,['-m','pip','install','argostranslate==1.11.0']);
  const directory=join(dataDir,'translation');await mkdir(directory,{recursive:true,mode:0o700});const adapter=join(root,'app/argos-translate.py');
  await run(executable,[adapter,'install','--pairs',selected.join(',')],{...process.env,WIEK_TRANSLATION_DATA:join(directory,'models'),VEK_TRANSLATION_DATA:join(directory,'models')});
  await writeFile(join(directory,'settings.json'),JSON.stringify({command:executable,args:[adapter],source:'en',target:'zh'},null,2),{mode:0o600,flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;console.log('Existing provider settings retained. Configure the installed runtime in Translation if needed.');});
  console.log('Offline translation installed ('+selected.join(', ')+') in '+dataDir);
}
