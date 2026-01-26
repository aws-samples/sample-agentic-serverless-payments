import React from "react";
import { useAppContext } from "../../context/AppContext";
import { useWebSocket } from "../../hooks/useWebSocket";

const WS_URL = import.meta.env.VITE_AWS_API_GATEWAY_WEBSOCKET_URL;

export const AgenticInterface = () => {
  const { addMessage, setIsGenerating } = useAppContext();
  const [prompt, setPrompt] = React.useState("");
  const [isLoading, setIsLoading] = React.useState(false);
  const { isConnected, lastMessage, sendMessage } = useWebSocket(WS_URL);

  const generateSessionId = () => {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
    return `session_${timestamp}_${random}`.substring(0, 50);
  };
  
  const [sessionId, setSessionId] = React.useState(generateSessionId());

  React.useEffect(() => {
    if (lastMessage) {
      if (lastMessage.type === 'complete') {
        const output = lastMessage.response?.output;
        if (output) {
          const messageContent = output.message?.content?.[0]?.text || 'No response';
          const images = output.images || {};
          
          addMessage({
            type: 'assistant' as const,
            content: messageContent,
            timestamp: new Date()
          });
          
          if (Object.keys(images).length > 0) {
            Object.values(images).forEach((imageData: any) => {
              addMessage({
                type: 'assistant' as const,
                content: imageData,
                timestamp: new Date()
              });
            });
          }
        }
        setIsLoading(false);
        setIsGenerating(false);
      } else if (lastMessage.type === 'error') {
        addMessage({
          type: 'assistant' as const,
          content: `Error: ${lastMessage.message}`,
          timestamp: new Date()
        });
        setIsLoading(false);
        setIsGenerating(false);
      }
    }
  }, [lastMessage]);

  const handleSubmit = () => {
    if (!prompt.trim() || !isConnected) return;

    const currentPrompt = prompt;
    setPrompt("");
    
    addMessage({
      type: 'user' as const,
      content: currentPrompt,
      timestamp: new Date()
    });
    
    setIsLoading(true);
    setIsGenerating(true);
    sendMessage({
      input: { prompt: currentPrompt },
      session_id: sessionId
    });
  };

  return (
    <>
      <div className="input-area">
        <div className="input-container">
          <button
            onClick={() => setSessionId(generateSessionId())}
            className="session-btn"
            title="Start new session"
          >
            New Session
          </button>
          
          <textarea
            value={prompt}
            onChange={(e: any) => setPrompt(e.target.value)}
            onKeyDown={(e: any) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (prompt.trim() && isConnected) {
                  handleSubmit();
                }
              }
            }}
            placeholder={isConnected ? "Enter your prompt..." : "Connecting..."}
            className="prompt-textarea"
            rows={1}
            disabled={!isConnected}
          />
          
          <button
            onClick={handleSubmit}
            disabled={isLoading || !prompt.trim() || !isConnected}
            className="send-btn"
          >
            {isLoading ? (
              <div className="spinner" />
            ) : (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
              </svg>
            )}
          </button>
        </div>
      </div>

      {isLoading && (
        <div className="loading-indicator">
          <div className="spinner" />
          Agent processing...
        </div>
      )}
    </>
  );
};
