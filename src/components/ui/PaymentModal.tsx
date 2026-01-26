interface PaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  cost: number;
  model?: string;
  walletAddress?: string;
}

export const PaymentModal = ({ isOpen, onClose, onConfirm, onCancel, cost, model, walletAddress }: PaymentModalProps) => {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <h3 style={{ margin: '0 0 1.5rem 0', color: '#232F3E', fontSize: '1.125rem' }}>Confirm Payment</h3>
        
        <div className="payment-details">
          <div className="payment-row">
            <span className="payment-label">Amount</span>
            <span className="payment-value" style={{ fontFamily: 'monospace', fontWeight: 600 }}>
              {(cost / 1e6).toFixed(6)} USDC
            </span>
          </div>
          
          <div className="payment-row">
            <span className="payment-label">Network</span>
            <span className="payment-value">
              <span className="network-badge">Base Sepolia</span>
            </span>
          </div>
          
          {model && (
            <div className="payment-row">
              <span className="payment-label">Model</span>
              <span className="payment-value">{model === 'nova-llm' ? 'Nova LLM' : 'Nova Canvas'}</span>
            </div>
          )}
          
          {walletAddress && (
            <div className="payment-row">
              <span className="payment-label">From</span>
              <span className="payment-value" style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                {walletAddress.slice(0, 10)}...{walletAddress.slice(-8)}
              </span>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.5rem' }}>
          <button
            onClick={() => { onClose(); onCancel(); }}
            className="btn-secondary"
            style={{ flex: 1 }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="btn-primary"
            style={{ flex: 1 }}
          >
            Sign & Pay
          </button>
        </div>
      </div>
    </div>
  );
};
