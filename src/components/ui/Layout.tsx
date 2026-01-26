import { useAppContext } from "../../context/AppContext";
import { ARCHITECTURES } from "../../config/models";
import { ModelToggle } from "./ModelToggle";
import type { Architecture } from "../../types";

interface LayoutProps {
  children: any;
  walletStatus?: { address: string | null; isCorrectNetwork: boolean } | null;
  connectionStatus?: { isConnected: boolean } | null;
}

export const Layout = ({ children, walletStatus, connectionStatus }: LayoutProps) => {
  const { config, updateArchitecture } = useAppContext();

  return (
    <div className="layout">
      <header className="header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1.5rem' }}>
          <div>
            <h1 style={{ fontSize: '1.25rem', margin: 0, fontWeight: 600 }}>Bedrock Payment Studio</h1>
            <span style={{ fontSize: '0.75rem', opacity: 0.8 }}>Powered by AWS & Coinbase x402</span>
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            {/* Architecture Toggle */}
            <div className="segmented-toggle">
              {(Object.keys(ARCHITECTURES) as Architecture[]).map((key) => (
                <button
                  key={key}
                  onClick={() => updateArchitecture(key)}
                  className={`segment-btn ${config.architecture === key ? 'active' : ''}`}
                >
                  {ARCHITECTURES[key].name}
                </button>
              ))}
            </div>

            {config.architecture === 'serverless' && <ModelToggle />}

            {/* Status Indicator */}
            {config.architecture === 'serverless' && walletStatus && (
              <div className="status-badge">
                <span className="status-icon">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="2" y="4" width="20" height="16" rx="2"/>
                    <path d="M22 10H2"/>
                    <circle cx="16" cy="15" r="2"/>
                  </svg>
                </span>
                <span className={`status-dot ${walletStatus.address ? (walletStatus.isCorrectNetwork ? 'connected' : 'warning') : 'disconnected'}`} />
                <span style={{ fontSize: '0.75rem' }}>
                  {walletStatus.address 
                    ? (walletStatus.isCorrectNetwork 
                        ? `${walletStatus.address.slice(0, 6)}...${walletStatus.address.slice(-4)}`
                        : 'Wrong Network')
                    : 'Not Connected'}
                </span>
              </div>
            )}

            {config.architecture === 'agentic' && connectionStatus && (
              <div className="status-badge">
                <span className={`status-dot ${connectionStatus.isConnected ? 'connected' : 'disconnected'}`} />
                <span style={{ fontSize: '0.75rem' }}>
                  {connectionStatus.isConnected ? 'WebSocket Connected' : 'Disconnected'}
                </span>
              </div>
            )}
          </div>
        </div>
      </header>
      <main className="main-content">{children}</main>
    </div>
  );
};
