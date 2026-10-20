/** A sun by its spectral class (stars.ts, prompts.ts `sunOf`): every MK letter and luminosity class, the ranged forms, the fallback. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {LUMINOSITY,SPECTRAL} from './stars.ts';
import {sunOf} from './prompts.ts';

test('every spectral letter has its colour; a main-sequence star is a plain sun',()=>{
  assert.deepEqual(['O5V','B3V','A0V','F5V','G2V','K5V','M4V'].map(sunOf),
    ['a blue sun','a blue-white sun','a white sun','a yellow-white sun','a yellow sun','an orange sun','a red sun']);
  assert.deepEqual(['L3','T6','Y0','C5,4','R8','N3','S4,2','DA2','DB5','WN6','WC8','WR'].map(sunOf),
    ['a deep red brown dwarf','a magenta brown dwarf','a dark brown dwarf','a deep red carbon star','a deep red carbon star','a deep red carbon star',
      'a red sun','a white dwarf sun','a white dwarf sun','a blue Wolf-Rayet star','a blue Wolf-Rayet star','a blue Wolf-Rayet star']);
  for(const l of Object.keys(SPECTRAL))assert.notEqual(sunOf(`${l}5`),'a blazing sun',l);
});

test('every luminosity class: hypergiant to white dwarf, the subdwarf prefix, and a ranged or mixed form by its first class',()=>{
  assert.deepEqual(['M2 0','B1Ia+','B8Ia','M2Iab','K3Ib','O7I','G8II','M2III','K1IV','K7V','sdK7','K7VI','DA1','A0VII'].map(c=>sunOf(c.replace(' ',''))),
    ['a red hypergiant sun','a blue-white hypergiant sun','a blue-white supergiant sun','a red supergiant sun','an orange supergiant sun','a blue supergiant sun',
      'a yellow bright giant sun','a red giant sun','an orange subgiant sun','an orange sun','an orange subdwarf sun','an orange subdwarf sun','a white dwarf sun','a white dwarf sun']);
  assert.deepEqual(['M2Ia-ab','K0IV-V','G8III/IV','B2.5V','M2Ia'].map(sunOf),['a red supergiant sun','an orange subgiant sun','a yellow giant sun','a blue-white sun','a red supergiant sun']);
  for(const [l,words] of Object.entries(LUMINOSITY))assert.ok(sunOf(`G2${l}`).includes(words||'yellow sun'),l);
});

test('anything unparseable is a blazing sun, and every phrase is at most six words',()=>{
  assert.deepEqual([null,undefined,'','unknown','Q7V','7V'].map(sunOf),Array(6).fill('a blazing sun'));
  for(const s of Object.keys(SPECTRAL))for(const l of Object.keys(LUMINOSITY))assert.ok(sunOf(`${s}5${l}`).split(' ').length<=6,`${s}5${l}`);
});
