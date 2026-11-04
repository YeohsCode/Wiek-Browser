import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskSpaceHandle} from '../packages/sdk/dist/src/page-model.js';
import {resetPageNotices,recordUnhandledPage,refreshUnhandledPageNotice} from '../packages/sdk/dist/src/page-discovery.js';

test('a late title/URL refresh of an old popup cannot satisfy a newly armed waiter',async()=>{
  resetPageNotices();
  const task=createTaskSpaceHandle({id:7,name:'fixture',ownership:'agent'},{ledger:{getPage:async()=>({targetId:'source',openedBy:'agent'})}});
  recordUnhandledPage({spaceId:7,targetId:'old',label:'p2',openerLabel:'p1',url:'about:blank'});
  const pending=task.page('p1').waitForEvent('popup',{timeout:1000});
  refreshUnhandledPageNotice(7,'old','https://fixture.test/loaded-old-popup');
  recordUnhandledPage({spaceId:7,targetId:'new',label:'p3',openerLabel:'p1',url:'https://fixture.test/new'});
  try{assert.equal((await pending).label,'p3');}finally{resetPageNotices();}
});
