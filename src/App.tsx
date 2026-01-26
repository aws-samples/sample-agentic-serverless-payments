import React from "react";
import { AppProvider, useAppContext } from "./context/AppContext";
import { Layout } from "./components/ui/Layout";
import { ServerlessInterface } from "./components/architectures/ServerlessInterface";
import { AgenticInterface } from "./components/architectures/AgenticInterface";
import { useAccount, useChainId } from 'wagmi';
import { baseSepolia } from 'viem/chains';
import { useWebSocket } from "./hooks/useWebSocket";
import "./App.css";

const WS_URL = import.meta.env.VITE_AWS_API_GATEWAY_WEBSOCKET_URL;

const UserAvatar = () => (
  <div className="avatar user">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
      <circle cx="12" cy="7" r="4"/>
    </svg>
  </div>
);

const BotAvatar = () => (
  <div className="avatar assistant">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2L2 7l10 5 10-5-10-5z"/>
      <path d="M2 17l10 5 10-5"/>
      <path d="M2 12l10 5 10-5"/>
    </svg>
  </div>
);

const TypingIndicator = () => (
  <div className="message-row assistant">
    <BotAvatar />
    <div className="typing-indicator">
      <span className="typing-dot" />
      <span className="typing-dot" />
      <span className="typing-dot" />
    </div>
  </div>
);

const copyToClipboard = (text: string) => {
  navigator.clipboard.writeText(text);
};

const downloadImage = async (src: string) => {
  try {
    if (src.startsWith('data:')) {
      // Data URL - direct download
      const link = document.createElement('a');
      link.href = src;
      link.download = `generated-${Date.now()}.png`;
      link.click();
    } else {
      // External URL (S3, etc.) - fetch and convert to blob
      const response = await fetch(src);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `generated-${Date.now()}.png`;
      link.click();
      URL.revokeObjectURL(url);
    }
  } catch (e) {
    // Fallback: open in new tab
    window.open(src, '_blank');
  }
};

const parseTransactionUrl = (content: string) => {
  const match = content.match(/https:\/\/sepolia\.basescan\.org\/tx\/0x[a-fA-F0-9]+/);
  return match ? match[0] : null;
};

const renderMarkdown = (text: string) => {
  let html = text
    .replace(/^### \*\*(.+?)\*\*$/gm, '<h3>$1</h3>')
    .replace(/^## \*\*(.+?)\*\*$/gm, '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^---$/gm, '<hr/>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/\n\n+/g, '\n')
    .replace(/\n/g, '<br/>');
  
  return html;
};

const MessageContent = ({ content, type }: { content: string; type: string }) => {
  const [copied, setCopied] = React.useState(false);
  
  const handleCopy = () => {
    copyToClipboard(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  
  const isImage = content.startsWith('data:image/') || 
    (content.startsWith('https://') && (content.includes('.png') || content.includes('.jpg') || content.includes('image')));
  
  const txUrl = parseTransactionUrl(content);
  
  if (isImage) {
    return (
      <div className="image-output">
        <img src={content} alt="Generated" />
        <div className="image-actions">
          <button className="action-btn" onClick={() => downloadImage(content)}>Download</button>
        </div>
      </div>
    );
  }

  // Check if this is a transaction confirmation message
  if (txUrl && type === 'assistant') {
    const cleanContent = content
      .replace(/✅\s*/g, '')
      .replace(/🔗\s*Transaction:\s*/g, '')
      .replace(/Transaction:\s*/g, '')
      .replace(txUrl, '')
      .trim();
    
    const parts = cleanContent.split('\n\n').filter(Boolean);
    const confirmationText = parts[0] || '';
    const generatedContent = parts.slice(1).join('\n\n');

    const hasMarkdown = generatedContent.includes('**') || generatedContent.includes('##') || generatedContent.includes('---');

    return (
      <div>
        {confirmationText && (
          <div className="tx-card">
            <div className="tx-header">Payment Confirmed</div>
            <a href={txUrl} target="_blank" rel="noopener noreferrer" className="tx-link">
              {txUrl}
            </a>
          </div>
        )}
        {generatedContent && (
          <div className="text-output">
            {hasMarkdown ? (
              <div className="markdown-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(generatedContent) }} />
            ) : (
              <div style={{ whiteSpace: 'pre-wrap' }}>{generatedContent}</div>
            )}
            <div className="copy-footer">
              <button className="copy-btn-inline" onClick={handleCopy}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}
        {!generatedContent && !confirmationText && (
          <div style={{ whiteSpace: 'pre-wrap' }}>{content}</div>
        )}
      </div>
    );
  }

  const hasMarkdown = content.includes('**') || content.includes('##') || content.includes('---');
  const showCopy = type === 'assistant' && content.length > 100;

  return (
    <div className="text-output">
      {hasMarkdown ? (
        <div className="markdown-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
      ) : (
        <div style={{ whiteSpace: 'pre-wrap' }}>{content}</div>
      )}
      {showCopy && (
        <div className="copy-footer">
          <button className="copy-btn-inline" onClick={handleCopy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  );
};

const AppContent = () => {
  const { config, messages, isGenerating } = useAppContext();
  const messagesEndRef = React.useRef<HTMLDivElement>(null);
  
  // Wallet status for serverless
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const isCorrectNetwork = chainId === baseSepolia.id;
  
  // WebSocket status for agentic
  const { isConnected: wsConnected } = useWebSocket(WS_URL);
  
  React.useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const walletStatus = config.architecture === 'serverless' 
    ? { address: isConnected ? address || null : null, isCorrectNetwork }
    : null;

  const connectionStatus = config.architecture === 'agentic'
    ? { isConnected: wsConnected }
    : null;
  
  return (
    <Layout walletStatus={walletStatus} connectionStatus={connectionStatus}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className="chat-container" style={{ paddingBottom: '80px' }}>
          {messages.length === 0 ? (
            <div className="welcome-container">
              <div className="welcome-content">
                <div className="welcome-title">Bedrock Payment Studio</div>
                <div className="welcome-subtitle">Select an architecture and enter a prompt to begin</div>
              </div>
            </div>
          ) : (
            <>
              {messages.map((message: any, index: number) => (
                <div key={index} className={`message-row ${message.type}`}>
                  {message.type === 'assistant' && <BotAvatar />}
                  <div className={`message-bubble ${message.type}`}>
                    <MessageContent content={message.content} type={message.type} />
                    <div className="message-time">
                      {message.timestamp.toLocaleTimeString()}
                    </div>
                  </div>
                  {message.type === 'user' && <UserAvatar />}
                </div>
              ))}
              {isGenerating && <TypingIndicator />}
            </>
          )}
          <div ref={messagesEndRef} />
        </div>
        
        {config.architecture === "serverless" ? (
          <ServerlessInterface />
        ) : (
          <AgenticInterface />
        )}
      </div>
    </Layout>
  );
};

function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}

export default App;
