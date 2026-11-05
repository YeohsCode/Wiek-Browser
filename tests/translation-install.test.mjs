import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installOfflineTranslation} from '../cli/translation-install.mjs';

test('invalid language requests cannot create directories or start an installer',async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'wiek-language-install-'));
  try{
    for(const pairs of ['en-en','en-es,en-es','en-es;echo bad','en-es,../../x','',Array(22).fill('en-es').join(',')]){
      const dataDir=join(temporary,'untouched');
      await assert.rejects(installOfflineTranslation({dataDir,python:process.execPath,root:temporary,pairs}),/language|pairs/);
      await assert.rejects(stat(dataDir),{code:'ENOENT'});
    }
  }finally{await rm(temporary,{recursive:true,force:true});}
});
