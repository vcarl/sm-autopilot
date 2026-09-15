import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SpacemoltError,ConnectionClosedError} from '@spacemolt/lib';
import {CommandBoundary} from './command-boundary.ts';

test('a swallowed uncertain later substep prevents subsequent sends and outer success',async()=>{
  for(const error of [new Error('transport failure'),new ConnectionClosedError('socket closed',1006),new SpacemoltError('mutation_timeout','no result'),new SpacemoltError('facility_required','Request rejected while another command is pending',{pendingCommand:'buy'})]){
    const boundary=new CommandBoundary();let sends=0;
    await boundary.run(async(sent,completed)=>{sent();sends++;completed();});
    await boundary.run(async(sent)=>{sent();sends++;throw error;}).catch(()=>({partial:true}));
    await assert.rejects(boundary.run(async(sent)=>{sent();sends++;}),error);
    assert.throws(()=>boundary.assertHealthy(),error);
    assert.equal(sends,2);
    assert.deepEqual(boundary.status(error),{outcome_unknown:true,fatal:true,action_completed:false});
  }
});

test('post-send refresh failures latch, but known game rejections remain recoverable',async()=>{
  const boundary=new CommandBoundary();
  const rejection=new SpacemoltError('no_resources','depleted');
  await boundary.run(async(sent)=>{sent();throw rejection;}).catch(()=>{});
  boundary.assertHealthy();
  assert.equal(boundary.status(rejection).fatal,false);
  const failure=new Error('canonical refresh lost');let sends=0;
  const account={async send(){sends++;return {};},async refresh(){throw failure;}};
  // A send that completed, then a failed canonical refresh: the shape every mutation runs.
  await boundary.run(async(sent,completed)=>{sent();await account.send();completed();await account.refresh();}).catch(()=>{});
  assert.throws(()=>boundary.assertHealthy(),failure);
  await assert.rejects(boundary.run(async()=>{sends++;}),failure);
  assert.equal(sends,1);
  assert.deepEqual(boundary.status(failure),{outcome_unknown:false,fatal:true,action_completed:true});
});
