/** Game replies arrive directly, as MCP content, or inside a state delta. */
export const details = (reply:any):Record<string,any> => reply?.structuredContent ?? reply?.delta?.details ?? reply ?? {};
