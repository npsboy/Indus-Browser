export {};

declare global {
  interface Window {
    api?: {
      minimizeWindow: () => void;
      maximizeWindow: () => void;
      closeWindow: () => void;
      runAgentInstruction: (instruction: string) => Promise<void>;
      stopAgent: () => void;
      pauseAgent: () => void;
      resumeAgent: () => void;
      onAgentDone: (callback: (_event: any, answer: string) => void) => (() => void);
    };
  }
}
