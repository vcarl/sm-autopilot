import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SpacemoltError,ConnectionClosedError} from '@spacemolt/lib';
import {replyLost} from './command-boundary.ts';

test('replyLost distinguishes an ambiguous send from a definitive rejection',()=>{
  assert.equal(replyLost(new ConnectionClosedError('socket closed',1006)),true);
  assert.equal(replyLost(new SpacemoltError('mutation_timeout','no result')),true);
  assert.equal(replyLost(new Error('boom')),false);
  assert.equal(replyLost(new assert.AssertionError({message:'Unexpected command'})),false);
  assert.equal(replyLost(new SpacemoltError('not_at_asteroid','Request rejected')),false);
});
