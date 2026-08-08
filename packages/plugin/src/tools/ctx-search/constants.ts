export const CTX_SEARCH_TOOL_NAME = "ctx_search";
export const CTX_SEARCH_DESCRIPTION = `Your long-term recall for this session — search raw history and historian compartments that are no longer visible in the live prompt.

Reach for it when something feels familiar but isn't in view: "did we solve this before?", "what did we decide about X?", "when did this break?", "where does Y live?". Results exclude the live conversation tail already visible to the agent.

Source filter:
- message: raw conversation FTS plus semantic historian-compartment search. Hits include message ordinals or compartment ranges for ctx_expand.`;
export const DEFAULT_CTX_SEARCH_LIMIT = 10;
