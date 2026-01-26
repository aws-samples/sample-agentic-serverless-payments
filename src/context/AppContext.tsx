import { createContext, useContext, useState } from "react";
import type { Architecture, NovaModel, AppConfig } from "../types";

interface Message {
  type: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface AppContextType {
  config: AppConfig;
  estimate: any;
  messages: Message[];
  isGenerating: boolean;
  updateArchitecture: (architecture: Architecture) => void;
  updateModel: (model: NovaModel) => void;
  updateEstimate: (estimate: any) => void;
  addMessage: (message: Message) => void;
  setIsGenerating: (value: boolean) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider = ({ children }: { children: any }) => {
  const [config, setConfig] = useState({
    architecture: "serverless" as Architecture,
    model: "nova-llm" as NovaModel,
  });
  const [estimate, setEstimate] = useState(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  const updateArchitecture = (architecture: Architecture) => {
    setConfig({ ...config, architecture });
    setMessages([]);
  };
  const updateModel = (model: NovaModel) => setConfig({ ...config, model });
  const updateEstimate = (estimate: any) => setEstimate(estimate);
  const addMessage = (message: Message) => {
    (setMessages as any)((prev: any) => [...prev, message]);
  };

  return (
    <AppContext.Provider value={{ config, estimate, messages, isGenerating, updateArchitecture, updateModel, updateEstimate, addMessage, setIsGenerating }}>
      {children}
    </AppContext.Provider>
  );
};

export const useAppContext = () => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppContext must be used within an AppProvider");
  return ctx;
};