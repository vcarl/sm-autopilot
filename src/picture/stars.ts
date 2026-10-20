/** A star's look by its spectral class, the one authored lookup the pictures use (Carl, 2026-10-19). The Morgan–Keenan (MK)
 * classification (Morgan, Keenan & Kellman, "An Atlas of Stellar Spectra", 1943; Keenan & McNeil 1989), its letters extended
 * by the Wolf–Rayet (W), brown dwarf (L, T, Y), carbon (C, R, N), S-type and white dwarf (D) classes. Plain data; prompts.ts
 * `sunOf` reads a class with it. */

/** The colour of a spectral letter, as standard references give it. One per letter: the subclass digit (0–9.5) moves a star's
 * temperature within its letter but not the colour those references name, so it is read and ignored. */
export const SPECTRAL:Record<string,string>={
  O:'blue',B:'blue-white',A:'white',F:'yellow-white',G:'yellow',K:'orange',M:'red',
  W:'blue',L:'deep red',T:'magenta',Y:'dark',C:'deep red',R:'deep red',N:'deep red',S:'red',D:'white',
};
/** What a letter is when it names a kind of star of its own and no luminosity class says otherwise. */
export const KINDS:Record<string,string>={W:'Wolf-Rayet star',L:'brown dwarf',T:'brown dwarf',Y:'brown dwarf',C:'carbon star',R:'carbon star',N:'carbon star',D:'white dwarf sun'};
/** The MK luminosity classes, longest first so a parser takes `Iab` before `Ia` and `III` before `II`; `V`, the main sequence,
 * is a plain sun. A ranged or mixed class ("Ia-ab", "IV-V", "III/IV") is read by its first. */
export const LUMINOSITY:Record<string,string>={
  'Ia+':'hypergiant','0':'hypergiant',Iab:'supergiant',Ia:'supergiant',Ib:'supergiant',III:'giant',II:'bright giant',IV:'subgiant',
  VII:'white dwarf',VI:'subdwarf',V:'',I:'supergiant',
};
/** The prefixes a class may carry before its letter: a subdwarf (`sd`, extreme `esd`, ultra `usd`). */
export const PREFIXES:Record<string,string>={sd:'subdwarf',esd:'subdwarf',usd:'subdwarf'};
/** A sun whose class cannot be read. */
export const NO_CLASS='a blazing sun';
