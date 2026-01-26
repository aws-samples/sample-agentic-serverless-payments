export type Architecture = "serverless" | "agentic";

export type NovaModel = "nova-llm" | "nova-canvas";

export interface AppConfig {
  architecture: Architecture;
  model: NovaModel;
}

export interface PromptRequest {
  content: string;
  model: NovaModel;
  architecture: Architecture;
}

export interface PromptResponse {
  id: string;
  content: string;
  model: NovaModel;
  architecture: Architecture;
  timestamp: string;
}
