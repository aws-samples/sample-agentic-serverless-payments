import { NovaModel } from "../types";

export const NOVA_MODELS: Record<
  NovaModel,
  { name: string; description: string }
> = {
  "nova-llm": {
    name: "Nova LLM",
    description: "Large Language Model for text generation and conversation",
  },
  "nova-canvas": {
    name: "Nova Canvas",
    description: "Multimodal AI for image generation and visual content",
  },
};

export const ARCHITECTURES = {
  serverless: {
    name: "Serverless",
    description: "Browser wallet payment flow",
  },
  agentic: {
    name: "Agentic",
    description: "Autonomous agent payment flow",
  },
} as const;
