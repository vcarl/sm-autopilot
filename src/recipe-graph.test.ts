/** Ported from spacemolt-lib PR #53 (Carl's) `tests/recipes.test.ts`, adapted to node:test;
 * to be replaced by the lib export once it ships. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type {CatalogItem,CatalogRecipe} from '@spacemolt/lib';
import {RecipeGraph} from './recipe-graph.ts';

/** Minimal recipe fixture — only the fields the graph reads plus the required ones. */
function r(
  id:string,
  output:string,
  inputs:Array<[string,number]>,
  extra:Partial<CatalogRecipe>={},
):CatalogRecipe {
  return {
    id,
    name:id,
    description:'',
    category:'Components',
    crafting_time:1,
    outputs:[{item_id:output,quantity:1}],
    inputs:inputs.map(([item_id,quantity])=>({item_id,quantity})),
    ...extra,
  };
}

function item(id:string,extra:Partial<CatalogItem>={}):CatalogItem {
  return {
    id,
    name:id,
    description:'',
    category:'ore',
    base_value:1,
    size:1,
    stackable:true,
    tradeable:true,
    ...extra,
  } as CatalogItem;
}

test('recipesFor returns multiple producers in catalog order',()=>{
  const g=new RecipeGraph([r('x_two','X',[['raw2',1]]),r('x_one','X',[['raw1',1]])]);
  assert.deepEqual(g.recipesFor('X').map(rr=>rr.id),['x_two','x_one']);
});

test('recipe / recipesFor / usesOf',()=>{
  const g=lookups();
  assert.equal(g.recipe('plate')?.name,'plate');
  assert.equal(g.recipe('nope'),undefined);
  assert.deepEqual(g.recipesFor('iron').map(x=>x.id),['refine_iron']);
  assert.deepEqual(g.recipesFor('unknown_item'),[]);
  assert.deepEqual(g.usesOf('ore_iron').map(x=>x.id),['refine_iron','plate']);
});

test('source resolves extraction, then craftability',()=>{
  const g=lookups();
  assert.equal(g.source('ore_iron'),'mining');
  assert.equal(g.source('iron'),'crafted');
  assert.equal(g.source('plate'),'crafted');
  assert.equal(g.source('mystery'),'unknown');
});

test('source passes any extraction kind through verbatim',()=>{
  const eg=new RecipeGraph(
    [],
    [
      item('g',{extracted_by:'gas'}),
      item('i',{extracted_by:'ice'}),
      item('rd',{extracted_by:'rad'}),
      item('weird',{extracted_by:'something_new'}),
    ],
  );
  assert.equal(eg.source('g'),'gas');
  assert.equal(eg.source('i'),'ice');
  assert.equal(eg.source('rd'),'rad');
  // Not mapped through a local union, so a method the server adds survives.
  assert.equal(eg.source('weird'),'something_new');
});

function lookups() {
  return new RecipeGraph(
    [
      r('refine_iron','iron',[['ore_iron',2]],{category:'Refining'}),
      r('plate','plate',[['iron',3],['ore_iron',1]]),
    ],
    [item('ore_iron',{extracted_by:'mining'}),item('iron')],
  );
}

test('isCraftable rejects hidden, facility-gated, passive and package recipes',()=>{
  const g=new RecipeGraph([]);
  assert.equal(g.isCraftable(r('ok','a',[])),true);
  assert.equal(g.isCraftable(r('h','a',[],{hidden:true})),false);
  assert.equal(g.isCraftable(r('f','a',[],{facility_only:true})),false);
  assert.equal(g.isCraftable(r('c','a',[],{category:'Facility Only'})),false);
  assert.equal(g.isCraftable(r('p','a',[],{category:'Ship Passive'})),false);
  assert.equal(g.isCraftable(r('pkg','a',[],{package_operation:'unpack'})),false);
});

const plate=r('plate','plate',[['iron',3],['ore_iron',1]]);
const coverageGraph=new RecipeGraph([plate],[item('ore_iron',{extracted_by:'mining'})]);

test('coverage is complete when everything is on hand',()=>{
  const cov=coverageGraph.coverage(plate,{iron:3,ore_iron:1});
  assert.equal(cov.covered,1);
  assert.equal(cov.complete,true);
  assert.deepEqual(cov.missing,[]);
  assert.equal(cov.runs,1);
});

test('partial coverage reports the deficit and its source',()=>{
  const cov=coverageGraph.coverage(plate,new Map([['iron',1]]));
  assert.equal(cov.covered,0.25); // 1 of 4 required units
  assert.equal(cov.complete,false);
  assert.deepEqual(cov.missing,[
    {item_id:'iron',quantity:2,source:'unknown'},
    {item_id:'ore_iron',quantity:1,source:'mining'},
  ]);
});

test('surplus does not inflate coverage past 1',()=>{
  assert.equal(coverageGraph.coverage(plate,{iron:100,ore_iron:100}).covered,1);
});

test('runs scale the requirement',()=>{
  const cov=coverageGraph.coverage(plate,{iron:3,ore_iron:1},2);
  assert.equal(cov.runs,2);
  assert.equal(cov.covered,0.5);
  assert.deepEqual(cov.missing,[
    {item_id:'iron',quantity:3,source:'unknown'},
    {item_id:'ore_iron',quantity:1,source:'mining'},
  ]);
});

test('an input-free recipe is fully covered',()=>{
  assert.equal(coverageGraph.coverage(r('free','x',[]),{}).covered,1);
});

const craftable=new RecipeGraph([
  r('full','full',[['ore',1]]),
  r('half','half',[['ore',1],['gas',1]]),
  r('third','third',[['ore',1],['gas',1],['ice',1]]),
  r('none','none',[['exotic',1]]),
  r('facility','facility',[['ore',1]],{facility_only:true}),
  r('refined','refined',[['ore',1]],{category:'Refining'}),
  r('secret','secret',[['ore',1]],{hidden:true}),
]);

test('craftableWith lists only partly-covered, craftable recipes, best-first',()=>{
  const got=craftable.craftableWith({ore:1});
  assert.deepEqual(got.map(c=>c.recipe.id),['full','refined','half','third']);
  assert.equal(got[0]!.complete,true);
  assert.equal(got[2]!.covered,0.5);
});

test('craftableWith excludes facility-only and hidden recipes by default',()=>{
  const ids=craftable.craftableWith({ore:1}).map(c=>c.recipe.id);
  assert.ok(!ids.includes('facility'));
  assert.ok(!ids.includes('secret'));
});

test('includeFacilityOnly adds facility recipes but never hidden ones',()=>{
  const ids=craftable.craftableWith({ore:1},{includeFacilityOnly:true}).map(c=>c.recipe.id);
  assert.ok(ids.includes('facility'));
  assert.ok(!ids.includes('secret'));
});

test('craftableWith filters by category',()=>{
  assert.deepEqual(craftable.craftableWith({ore:1},{categories:['Refining']}).map(c=>c.recipe.id),['refined']);
});

test('a recipe with nothing on hand is omitted',()=>{
  assert.ok(!craftable.craftableWith({ore:1}).map(c=>c.recipe.id).includes('none'));
});
