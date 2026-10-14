import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReleaseTarget } from './release-policy.mjs';
const sha='a'.repeat(40);
const response=(body,status=200)=>({status,ok:status===200,json:async()=>body});
test('a new tag or a tag on the same commit can be published',async()=>{
  await assertReleaseTarget('owner/repo','v1.0.0',sha,'test',async()=>response({},404));
  await assertReleaseTarget('owner/repo','v1.0.0',sha,'test',async()=>response({object:{type:'commit',sha}}));
});
test('an existing tag on a different commit cannot be overwritten',async()=>{
  await assert.rejects(assertReleaseTarget('owner/repo','v1.0.0',sha,'test',async()=>response({object:{type:'commit',sha:'b'.repeat(40)}})));
});
test('annotated tags are dereferenced; network/auth failures are not treated as missing tags',async()=>{
  let calls=0;
  await assertReleaseTarget('owner/repo','v1.0.0',sha,'test',async()=>response(++calls===1?{object:{type:'tag',sha:'b'.repeat(40)}}:{object:{type:'commit',sha}}));
  assert.equal(calls,2);
  await assert.rejects(assertReleaseTarget('owner/repo','v1.0.0',sha,'test',async()=>response({},403)));
});
