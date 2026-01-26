import React from 'react';

export const useWebSocket = (url: string) => {
  const [isConnected, setIsConnected] = React.useState(false);
  const [lastMessage, setLastMessage] = React.useState<any>(null);
  const wsRef = React.useRef<WebSocket | null>(null);

  React.useEffect(() => {
    const connect = () => {
      const ws = new WebSocket(url);
      
      ws.onopen = () => {
        setIsConnected(true);
      };
      
      ws.onmessage = (event) => {
        setLastMessage(JSON.parse(event.data));
      };
      
      ws.onclose = () => {
        setIsConnected(false);
        setTimeout(connect, 3000);
      };
      
      ws.onerror = () => ws.close();
      
      wsRef.current = ws;
    };

    connect();
    return () => wsRef.current?.close();
  }, [url]);

  const sendMessage = (data: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  };

  return { isConnected, lastMessage, sendMessage };
};
