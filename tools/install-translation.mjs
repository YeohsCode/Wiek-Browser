#!/usr/bin/env node
import {resolve} from 'node:path';import {fileURLToPath} from 'node:url';import{installOfflineTranslation}from'../cli/translation-install.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));await installOfflineTranslation({root,dataDir:resolve(process.env.VEK_DATA_DIR||process.argv[2]||'data'),python:process.argv[3]||'/opt/homebrew/bin/python3.12'});
