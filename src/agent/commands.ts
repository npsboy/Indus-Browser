export type AgentCommand =
  | { type: "agent:new-tab"; url?: string }
  | { type: "agent:close-active-tab" }
  | { type: "agent:reload-active-tab" }
  | { type: "agent:click"; x: number; y: number }
  | { type: "agent:scroll"; x: number; y: number; deltaY: number }
  | { type: "agent:navigate"; url: string }
  | { type: "agent:screenshot" };

