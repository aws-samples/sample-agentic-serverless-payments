import React from "react";
import { useAppContext } from "../../context/AppContext";
import { useAccount, useDisconnect, useWalletClient, useChainId, useSwitchChain } from 'wagmi';
import { useAppKit } from '@reown/appkit/react';
import { createWalletClient, custom, publicActions, keccak256, encodeAbiParameters } from 'viem';
import { baseSepolia } from 'viem/chains';
import { PaymentModal } from '../ui/PaymentModal';

const HTTP_API_URL = import.meta.env.VITE_AWS_API_GATEWAY_HTTP_URL;

export const ServerlessInterface = () => {
  const { config, addMessage, setIsGenerating } = useAppContext();
  const [prompt, setPrompt] = React.useState("");
  const [isLoading, setIsLoading] = React.useState(false);
  const [loadingMessage, setLoadingMessage] = React.useState('');
  const [showPaymentModal, setShowPaymentModal] = React.useState(false);
  const [paymentRequirements, setPaymentRequirements] = React.useState(null as any);
  const [currentPrompt, setCurrentPrompt] = React.useState('');
  const { address, isConnected } = useAccount();
  const { open } = useAppKit();
  const { disconnect } = useDisconnect();
  const { data: walletClient } = useWalletClient();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const account = isConnected ? address : null;
  const isCorrectNetwork = chainId === baseSepolia.id;

  React.useEffect(() => {
    const clearStaleConnections = () => {
      try {
        localStorage.removeItem('wagmi.store');
        localStorage.removeItem('wagmi.cache');
        localStorage.removeItem('wagmi.wallet');
        sessionStorage.removeItem('wagmi.store');
        sessionStorage.removeItem('wagmi.cache');
      } catch (e) {
        // Ignore
      }
    };
    
    if (!isConnected) {
      clearStaleConnections();
    }
  }, []);

  const handleSubmit = async () => {
    if (!account || !walletClient) return;
    if (!prompt.trim()) return;
    
    if (!isCorrectNetwork) {
      try {
        setLoadingMessage('Switching to Base Sepolia...');
        await switchChain({ chainId: baseSepolia.id });
        setLoadingMessage('');
      } catch (err: any) {
        addMessage({
          type: 'assistant' as const,
          content: 'Please switch to Base Sepolia testnet in your wallet',
          timestamp: new Date()
        });
        return;
      }
    }
    
    const savedPrompt = prompt;
    setCurrentPrompt(savedPrompt);
    setPrompt("");
    setIsLoading(true);
    setIsGenerating(true);
    setLoadingMessage('Getting payment requirements...');
    
    addMessage({
      type: 'user' as const,
      content: savedPrompt,
      timestamp: new Date()
    });
    
    try {
      const initialResponse = await fetch(`${HTTP_API_URL}generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: savedPrompt,
          model: config.model,
          architecture: 'serverless'
        })
      });
      
      if (initialResponse.status !== 402) {
        const data = await initialResponse.json();
        throw new Error(data.error || 'Unexpected response');
      }
      
      const requirements = await initialResponse.json();
      setPaymentRequirements(requirements);
      setShowPaymentModal(true);
      setIsLoading(false);
      setIsGenerating(false);
      setLoadingMessage('');
    } catch (err: any) {
      addMessage({
        type: 'assistant' as const,
        content: `Error: ${err.message}`,
        timestamp: new Date()
      });
      setIsLoading(false);
      setIsGenerating(false);
      setLoadingMessage('');
    }
  };

  const handlePaymentConfirm = async () => {
    if (!walletClient) return;
    
    setShowPaymentModal(false);
    setIsLoading(true);
    setIsGenerating(true);
    setLoadingMessage('Processing payment...');
    
    try {
      const viemClient = createWalletClient({
        account: walletClient.account,
        chain: baseSepolia,
        transport: custom((window as any).ethereum)
      }).extend(publicActions);
      
      const now = Math.floor(Date.now() / 1000);
      const nonce = keccak256(encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }],
        [account as `0x${string}`, BigInt(Date.now())]
      ));
      
      const authorization = {
        from: account as `0x${string}`,
        to: paymentRequirements.payTo as `0x${string}`,
        value: paymentRequirements.maxAmountRequired,
        validAfter: now.toString(),
        validBefore: (now + 3600).toString(),
        nonce
      };
      
      const domain = {
        name: 'USDC',
        version: '2',
        chainId: baseSepolia.id,
        verifyingContract: paymentRequirements.asset as `0x${string}`
      };
      
      const types = {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' }
        ]
      };
      
      setLoadingMessage('Waiting for signature...');
      
      const signature = await viemClient.signTypedData({
        account: viemClient.account!,
        domain,
        types,
        primaryType: 'TransferWithAuthorization',
        message: {
          from: authorization.from,
          to: authorization.to,
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
          nonce: authorization.nonce
        }
      });
      
      setLoadingMessage('Processing payment...');
      
      const paymentPayload = {
        signature,
        authorization: {
          from: authorization.from,
          to: authorization.to,
          value: authorization.value,
          validAfter: authorization.validAfter,
          validBefore: authorization.validBefore,
          nonce: authorization.nonce
        },
        eip712Domain: {
          name: domain.name,
          version: domain.version,
          chainId: domain.chainId,
          verifyingContract: domain.verifyingContract
        }
      };
      
      const paidResponse = await fetch(`${HTTP_API_URL}generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'PAYMENT-SIGNATURE': btoa(JSON.stringify(paymentPayload))
        },
        body: JSON.stringify({
          content: currentPrompt,
          model: config.model,
          architecture: 'serverless'
        })
      });
      
      const data = await paidResponse.json();
      const isImage = data.content && data.content.startsWith('data:image/');
      
      if (isImage) {
        let confirmationContent = '';
        if (data.message) confirmationContent += `${data.message}\n\n`;
        if (data.transactionUrl) confirmationContent += `Transaction: ${data.transactionUrl}`;
        
        if (confirmationContent) {
          addMessage({
            type: 'assistant' as const,
            content: confirmationContent,
            timestamp: new Date()
          });
        }
        
        addMessage({
          type: 'assistant' as const,
          content: data.content,
          timestamp: new Date()
        });
      } else {
        let responseContent = '';
        if (data.message) responseContent += `${data.message}\n\n`;
        if (data.transactionUrl) responseContent += `Transaction: ${data.transactionUrl}\n\n`;
        responseContent += data.content || 'No response generated';
        
        addMessage({
          type: 'assistant' as const,
          content: responseContent,
          timestamp: new Date()
        });
      }
    } catch (err: any) {
      addMessage({
        type: 'assistant' as const,
        content: `Error: ${err.message}`,
        timestamp: new Date()
      });
    } finally {
      setIsLoading(false);
      setIsGenerating(false);
      setLoadingMessage('');
    }
  };

  const handlePaymentCancel = () => {
    setShowPaymentModal(false);
    setPaymentRequirements(null);
  };

  return (
    <>
      <PaymentModal
        isOpen={showPaymentModal}
        onClose={() => setShowPaymentModal(false)}
        onConfirm={handlePaymentConfirm}
        onCancel={handlePaymentCancel}
        cost={paymentRequirements?.maxAmountRequired || 0}
        model={config.model}
        walletAddress={account || undefined}
      />
      
      <div className="input-area">
        <div className="input-container">
          {account && (
            <button onClick={() => disconnect()} className="disconnect-btn">
              Disconnect
            </button>
          )}
          
          <textarea
            value={prompt}
            onChange={(e: any) => setPrompt(e.target.value)}
            onKeyDown={(e: any) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (account && prompt.trim()) {
                  handleSubmit();
                } else if (!account) {
                  open();
                }
              }
            }}
            placeholder="Enter your prompt..."
            className="prompt-textarea"
            rows={1}
          />
          
          <button
            onClick={account ? handleSubmit : () => open()}
            disabled={isLoading || (!!account && !prompt.trim())}
            className={`send-btn ${!account ? 'connect' : ''}`}
          >
            {isLoading ? (
              <div className="spinner" />
            ) : account ? (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
              </svg>
            ) : (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="4" width="20" height="16" rx="2"/>
                <path d="M22 10H2"/>
                <circle cx="16" cy="15" r="2"/>
              </svg>
            )}
          </button>
        </div>
      </div>

      {loadingMessage && (
        <div className="loading-indicator">
          <div className="spinner" />
          {loadingMessage}
        </div>
      )}
    </>
  );
};
