type Row = Record<string, any>;
/** Only explicit catalog facts can reject a skill gate; missing metadata is unknown. */
export function recipePrerequisites(recipe:Row,venues:Row[],skills:Row) {
  const blockers:string[]=[],unknowns:string[]=[];
  const required=recipe.required_skills??recipe.skill_requirements;
  if(required && !Array.isArray(required) && typeof required==='object') {
    for(const [id,level] of Object.entries(required)) {
      if(typeof level!=='number'||!Number.isFinite(level))continue;
      const current=skills[id]?.level;
      if(typeof current!=='number')unknowns.push(`Unknown skill level: ${id}`);
      else if(current<level)blockers.push(`Requires ${id} level ${level}; current ${current}`);
    }
  } else unknowns.push('Catalog does not publish skill requirements');
  if(recipe.facility_only && !venues.some(v=>v.recipe_id===recipe.id && v.production?.public!==false))blockers.push('No observed matching accessible facility');
  return {blockers,unknowns};
}
