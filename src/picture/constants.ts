export const SIZE={width:800,height:600} as const;
export const ART_SIZE={width:1024,height:768} as const;
export const RUNS=28; export const GAP=24; export const PITCH_MAX=17; export const LANE_PAD=6; export const DENSE_PITCH=9; export const SMALL_FONT_PITCH=12; export const LONG_STAY_MIN=25; export const MIN_EPOCH_SHARE=1/8; export const BUCKET_MIN=20;
export const DONUT={floor:7,cap:22,scale:1.6} as const;
export const EPOCH_HUES=['#2EC4B6','#F4A261','#B388EB','#E76F8A','#8BC34A','#6FA8DC'] as const;
export const KINDS=['fights','docked','traded','fuel','creatures'] as const; export type Kind=typeof KINDS[number];
export const KIND_COLOURS:Record<Kind,string>={fights:'#E8554E',docked:'#4A90E2',traded:'#4CAF50',fuel:'#F2B134',creatures:'#A66BBE'};
/** The context runs' colour: muted grey for their donuts, route, step line and tints. */
export const MUTED_HUE='#5C6780';
export const hueOf=(epochIndex:number)=>EPOCH_HUES[epochIndex%EPOCH_HUES.length]??EPOCH_HUES[0];
