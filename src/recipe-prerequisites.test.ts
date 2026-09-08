import test from 'node:test';
import assert from 'node:assert/strict';
import {recipePrerequisites} from './recipe-prerequisites.ts';
test('known skill and facility blockers are local; omitted skill metadata is unknown',()=>{
  const recipe={id:'r',facility_only:true,required_skills:{refining:3}};
  assert.equal(recipePrerequisites(recipe,[],{refining:{level:2}}).blockers.length,2);
  assert.equal(recipePrerequisites(recipe,[{recipe_id:'r',production:{public:true}}],{refining:{level:3}}).blockers.length,0);
  assert.equal(recipePrerequisites(recipe,[{recipe_id:'r',production:{public:false}}],{refining:{level:3}}).blockers.length,1);
  assert.equal(recipePrerequisites({id:'workshop'},[],{}).blockers.length,0);
  assert.ok(recipePrerequisites({id:'workshop'},[],{}).unknowns.length);
});
