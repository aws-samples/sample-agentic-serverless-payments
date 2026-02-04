# Agentic and Serverless Payments on AWS

**Authored by:** Chris Wajule and Simon Goldberg

This solution demonstrates pay-per-use AI content generation using the x402 payment protocol. Users pay with USDC on Base Sepolia to access Amazon Nova 2 Lite for text and Amazon Nova Canvas for image generation. Two payment architectures are included: the serverless flow where users sign payments via browser wallets, and the agentic flow using the Strands agent powered by Amazon Bedrock AgentCore with CDP AgentKit, both utilizing the x402.org facilitator to verify signatures and settle payments on-chain via EIP-3009 transferWithAuthorization.

## Table of Contents

- [Architecture](#architecture)
  - [Serverless](#serverless)
  - [Agentic](#agentic)
- [Architecture Comparison](#architecture-comparison)
- [Deployment](#deployment)
  - [Prerequisites](#prerequisites)
  - [Quick Start](#quick-start)
  - [Manual Installation](#manual-installation)
- [Using the Platform](#using-the-platform)
- [API Reference](#api-reference)
- [Development and Testing](#development-and-testing)
- [Clean Up](#clean-up)
- [Troubleshooting](#troubleshooting)

## Architecture

### Serverless

![AWS Serverless x402 Payments Architecture](assets/AWS-Serverless-X402-Payments.png)

The solution includes three main components: Request Initiation (salmon arrows, steps 1-2, 5, 12), Payment Processing (green arrows, steps 3-4, 6, 7-9), and Content Delivery (orange arrows, steps 10-11).

The numbers in the following flow correspond to the serverless stablecoin payment for AI-generated content:

1. **Wallet Connection:** The user clicks the wallet connect button in the React frontend. The application uses Reown AppKit to display available wallet options. The user selects their wallet and approves the connection request.

2. **Initial Request:** The user submits a prompt through the chat interface. The application sends a POST request to the `/generate` endpoint on Amazon API Gateway without payment credentials.

3. **Cost Estimation:** The Estimator Lambda function uses Amazon Bedrock `CountTokens` API to calculate input tokens. It estimates output tokens using a conservative formula (minimum 800 tokens with 20% safety margin) and applies Amazon Nova 2 Lite pricing ($0.0003 input, $0.0025 output per 1K tokens). Amazon Nova Canvas returns a fixed $0.04 per image.

4. **Payment Requirements:** The Seller Lambda function detects the missing `PAYMENT-SIGNATURE` header and returns `HTTP 402`. The response includes the USDC amount in wei, the seller wallet address, the USDC contract address on Base Sepolia, and `EIP-712` domain parameters.

5. **Payment Authorization:** The frontend is hosted on AWS Amplify and displays a payment modal with the cost preview. The user confirms and the application generates an `EIP-712` typed data signature using the connected wallet. The wallet prompts the user to sign the message. The signature authorizes the USDC transfer with validity timestamps and a unique nonce.

6. **Payment Submission:** The frontend retries the `/generate` request with the `EIP-712` signature in the `PAYMENT-SIGNATURE` header. The request includes the authorization object (from, to, value, validAfter, validBefore, nonce) and signature.

7. **Idempotency Check:** The Seller Lambda extracts the nonce and checks an in-memory cache to prevent replay attacks. If the nonce exists, it returns `HTTP 409`.

8. **Payment Verification:** The AWS Lambda function sends the payment payload to the x402.org facilitator's `/verify` endpoint. The facilitator validates the `EIP-712` signature against the USDC contract domain on Base Sepolia.

9. **Payment Settlement:** The Lambda calls the facilitator's `/settle` endpoint. The facilitator executes the USDC transfer on-chain using `EIP-3009 transferWithAuthorization` and returns the transaction hash.

10. **Content Generation:** The AWS Lambda function invokes the Bedrock Lambda function. For text, it calls Amazon Nova 2 Lite using the `invoke_model` API. For images, it invokes Amazon Nova Canvas.

11. **Response Delivery:** The Bedrock Lambda returns the generated content. The Seller Lambda constructs a response with the success message, transaction url (`https://sepolia.basescan.org/tx/{hash}`), and generated content.

12. **Frontend Display:** The application displays the payment confirmation, transaction hash, and AI-generated content in the chat interface.

### Agentic

![AWS Agentic x402 Payments Architecture](assets/AWS-Agentic-X402-Payments.png)

The solution includes three main components: Request Initiation (salmon arrows, steps 1-2), Payment Processing (green arrows, steps 4-11), and Content Delivery (orange arrows, steps 3, 12-14).

The numbers in the following flow correspond to an autonomous agent executing stablecoin payments for AI-generated content:

1. **WebSocket Connection:** The user connects to the Amazon API Gateway WebSocket endpoint. The Connect Lambda stores the connection ID in Amazon DynamoDB.

2. **User Request:** The user sends a prompt with a session ID via a WebSocket connection. The Agent Lambda forwards the request to Amazon Bedrock AgentCore Runtime `/invocations` endpoint. The request includes a session ID for isolation.

3. **Agent Initialization:** Amazon Bedrock AgentCore loads the agent configuration and initializes Amazon Bedrock AgentCore Memory for session storage. The agent using Anthropic Claude Sonnet 4.5 as the reasoning engine, receives the prompt and determines the required action.

4. **Cost Estimation:** The agent invokes the `estimate_image_cost` tool. The tool calculates the fixed cost ($0.04 USDC for `1024x1024` standard quality) and generates a unique request ID. The cost, prompt, and authorization status (`auth: false`) are stored in Amazon Bedrock AgentCore Memory.

5. **Authorization Check:** The agent calls `generate_image` tool. The tool checks the authorization status in session storage and finds `auth:false`. The tool returns `AUTHORIZE_CHECK` status directly to the agent without calling the gateway. This confirms user intent to pay and is not part of the x402 flow. The check is automatic but can be an explicit natural language confirmation corresponding to an CDP AgentKit wallet’s allowance.

6. **Payment Authorization:** The agent calls `make_payment`. The tool verifies sufficient balance exists and sets `auth:true` in session storage. This marks the user's intent to proceed with payment but does not transfer funds

7. **Initial x402 Request:** The agent calls `generate_image` again. The tool finds `auth:true` and creates an x402 HTTP client using the CDP AgentKit wallet's dynamically exported private key. The client sends a POST request to Amazon API Gateway without an `PAYMENT-SIGNATURE` header.

8. **402 Payment Required:** AWS Lambda receives the request and returns `HTTP 402` with payment requirements. The response includes the USDC amount in wei, seller wallet address, USDC contract address, and `EIP-712` domain parameters (name: 'USDC', version: '2', chainId: 84532).

9. **EIP-712 Signature Generation:** The x402 client receives the 402 response and constructs `EIP-712` typed data. It signs the data using the CDP AgentKit wallet's `private key`, base64-encodes the signature payload, and retries the POST request with the signature in the `PAYMENT-SIGNATURE` header.

10. **Payment Verification:** Lambda extracts the payment payload from the `PAYMENT-SIGNATURE` header. It checks the nonce against the `processedPayments` map to prevent replay attacks. Lambda sends the signature to the x402.org facilitator's `/verify` endpoint, which validates the `EIP-712` signature against the USDC contract domain on Base Sepolia.

11. **Payment Settlement:** AWS Lambda calls the facilitator's `/settle` endpoint. The facilitator executes the USDC transfer on Base Sepolia using `EIP-3009 transferWithAuthorization` and returns the transaction hash. Lambda stores the hash in context, marks the nonce as processed, and returns `HTTP 200` with payment confirmation.

12. **Image Generation:** The tool invokes Amazon Nova Canvas model using the `invoke_model` API. Nova Canvas generates a `1024x1024` image based on the prompt.

13. **Response Delivery:** The generated image is stored in Amazon Simple Storage Service , and its unique ID is stored in session storage. The agent returns a success message to the frontend hosted an AWS Amplifywhich includes the base64-encoded image, transaction hash, and a BaseScan explorer link(`https://sepolia.basescan.org/tx/{hash}`) for on-chain verification.

14. **Session Cleanup:** The tool clears the current request ID from session storage. This allows new image generation requests while maintaining payment history for the session.

## Architecture Comparison

### Use Case Alignment

Serverless handles simple, transactional interactions. Users know what they want, need a single piece of content, and prefer explicit control over each payment.

Agentic targets complex, exploratory workflows. Users describe goals in natural language, iterate on content through conversation, or delegate payment decisions within spending limits.

### Image Handling

Serverless returns images directly in HTTP response bodies. For small images or when clients handle base64 encoding, this provides the simplest implementation.

Agentic offloads images to Amazon S3 due to WebSocket message size constraints. This adds complexity but enables handling large media files. Presigned URLs provide secure, temporary access.

### Payment Models

Serverless implements pay-per-request semantics. Each API call requires separate payment authorization. Users explicitly approve every transaction.

Agentic implements pay-per-session semantics. Users authorize a session budget. The agent manages spending within that limit across multiple operations.

### Communication Patterns

Serverless uses synchronous HTTP request-response patterns. Each request is independent and expects a single response.

Agentic uses asynchronous WebSocket bidirectional streaming. Connections persist across multiple message exchanges. This enables server-initiated messages and incremental response delivery.

### State Management

Serverless is stateless. AWS Lambda functions have no memory of previous requests. Clients maintain all session context.

Agentic maintains session state through Amazon DynamoDB and Amazon Bedrock AgentCore Memory. The agent remembers conversation history, user preferences, and cumulative spending within a session.

### Orchestration Models

Serverless orchestration is explicit and deterministic. The Seller Lambda follows a fixed sequence: check payment, verify authorization, invoke generation, return results.

Agentic orchestration is autonomous and adaptive. Amazon Bedrock AgentCore Runtime decides which tools to invoke based on user intent. The agent handles variations in request structure and adapts to errors.

### Scalability

Serverless scales horizontally without coordination overhead. Amazon API Gateway and AWS Lambda handle thousands of concurrent requests. Cold starts are the primary latency consideration.

Agentic scalability is constrained by WebSocket connection limits and Amazon Bedrock AgentCore Runtime capacity. Connection pooling and lifecycle management become operational concerns.

### Latency Profiles

Serverless incurs cold start latency when AWS Lambda functions initialize. Subsequent requests to warm functions complete quickly.

Agentic maintains warm WebSocket connections, eliminating connection establishment overhead. However, Amazon Bedrock AgentCore Runtime introduces reasoning latency as Claude Sonnet 4.5 analyzes prompts and plans tool invocations.

## Deployment

### Prerequisites

1. AWS Account with appropriate permissions
2. Node.js 18.x or later
3. AWS CDK CLI installed (`npm install -g aws-cdk`)
4. AWS CLI configured with credentials
5. USDC on Base Sepolia for testing (obtain from [Circle Faucet](https://faucet.circle.com/))
6. WalletConnect Project ID from [Reown Cloud](https://cloud.reown.com)
7. CDP API credentials from [Coinbase Developer Platform](https://portal.cdp.coinbase.com)
8. Bash shell (Windows users: use WSL or Git Bash)

#### Clone Repository

```bash
git clone https://github.com/aws-samples/sample-agentic-serverless-payments.git
```

> **Note:** Lambda dependencies are bundled automatically by esbuild during CDK deployment. No separate `npm install` is required in Lambda directories.

#### Configure Environment Variables

Parameters are sourced from `.env` files during deployment.

**Root directory (for serverless and frontend):**

```bash
cp .env-sample .env
```

Update the root `.env` file with the following values:

| Variable | Source |
|----------|--------|
| `VITE_PAYER_WALLETCONNECT_PROJECT_ID` | [Reown Cloud](https://cloud.reown.com) |
| `SELLER_WALLET_ADDRESS` | Your wallet address to receive USDC |
| `AGENT_RUNTIME_ARN` | AgentCore Runtime ARN (from Step 3) |

> **Note:** API Gateway URLs (`VITE_AWS_API_GATEWAY_HTTP_URL`, `VITE_AWS_API_GATEWAY_WEBSOCKET_URL`, `API_GATEWAY_HTTP_URL`) are exported automatically from the CDK stack after deployment. CDP credentials (`CDP_API_KEY_NAME`, `CDP_API_KEY_SECRET`) are optional and only required for mainnet deployment (code edits required).

**Agentic directory (for agent deployment):**

```bash
cd agentic
cp .env-sample .env
cd ..
```

Update the `agentic/.env` file with the following values:

| Variable | Source |
|----------|--------|
| `CDP_API_KEY_ID` | [Coinbase Developer Platform](https://portal.cdp.coinbase.com/) |
| `CDP_API_KEY_SECRET` | Coinbase Developer Platform |
| `CDP_WALLET_SECRET` | Generated CDP wallet secret |
| `NETWORK_ID` | `base-sepolia` |
| `RPC_URL` | `https://sepolia.base.org` |
| `USDC_CONTRACT` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| `SELLER_WALLET` | Your wallet address to receive USDC |
| `GATEWAY_URL` | API Gateway HTTP URL (from Step 3, without trailing slash) |
| `AWS_REGION` | `us-east-1` |

> **Note:**  When configuring the Coinbase Developer Platform API Key, enable View, Trade, Transfer, and Export & Manage for Server Wallet.

### Quick Start

For complete automated setup:

```bash
# 1. Make sure you have copied and configured your .env files

# 2. Run the complete setup
npm run setup
```

This script handles all installation, deployment, and configuration steps automatically.

### Manual Installation

#### Step 1: Install Dependencies

```bash
npm install
```

#### Step 2: Deploy Serverless Architecture

```bash
npm run setup-serverless
```

#### Step 3: Deploy Agentic Architecture

```bash
npm run setup-agentic
```

#### Step 4: Run Frontend Locally

```bash
npm run dev
```

Open the URL displayed in the terminal (typically `http://localhost:5173`).

#### Step 5: Deploy Frontend to AWS Amplify (Optional)

**Option A: AWS CLI**

```bash
npm run setup-amplify
```

**Option B: Amplify Console (Recommended for CI/CD)**

1. Go to [AWS Amplify Console](https://console.aws.amazon.com/amplify/)
2. Click **Deploy an App**
3. Connect your Git repository and select the branch
4. In **Build settings**, Amplify auto-detects the `amplify.yml` configuration
5. In **Hosting settings** → **Environment variables**, add:

| Variable | Value |
|----------|-------|
| `VITE_AWS_API_GATEWAY_HTTP_URL` | Your HTTP API URL from CDK outputs |
| `VITE_AWS_API_GATEWAY_WEBSOCKET_URL` | Your WebSocket URL from CDK outputs |
| `VITE_PAYER_WALLETCONNECT_PROJECT_ID` | Your WalletConnect Project ID |

6. Click **Save and deploy**

## Using the Platform

### Serverless Architecture (Browser Wallet)

1. **Open the application** in your browser at the deployed Amplify URL or `http://localhost:5173` for local development.

2. **Select architecture:** Click "Serverless" in the top navigation.

3. **Select model:** Choose "Nova LLM" for text generation or "Nova Canvas" for image generation.

4. **Connect wallet:** Click the wallet button (👛) to open the WalletConnect modal. Select your wallet and approve the connection. Ensure you are on Base Sepolia network.

5. **Submit a prompt:** Type your request in the chat input and press Enter or click the send button.

6. **Review payment:** A modal displays the estimated cost in USDC. Click "Confirm" to proceed.

7. **Sign transaction:** Your wallet prompts you to sign the EIP-712 message. This authorizes the USDC transfer but does not execute it yet.

8. **Receive content:** After payment verification and settlement, the AI-generated content appears in the chat along with the transaction URL.

### Agentic Architecture (Autonomous Agent)

1. **Open the application** and select "Agentic" in the top navigation.

2. **Verify connection:** The green indicator (🟢) confirms WebSocket connection to the agent.

3. **Submit a prompt:** Type your image generation request and press Enter.

4. **Agent processing:** The agent autonomously estimates cost, verifies balance, authorizes payment, and generates content.

5. **Receive content:** The generated image and transaction confirmation appear in the chat.

### Example Conversation

```
User: What can you help me with?

Agent: I can help you with several image-related tasks:

       🎨 Image Generation
       - Create images using Amazon Nova Canvas based on your text descriptions
       - Handle the payment process automatically through x402 protocol

       💰 Wallet Management
       - Check your wallet balance (ETH and USDC)
       - Estimate costs for image generation before creating them

       🔍 Image Analysis
       - Analyze generated images for content monetization opportunities

User: What are my wallet details?

Agent: Here are your wallet details:

       Wallet Address: 0xxxx...xxxx
       Network: Base Sepolia (Chain ID: 84532)

       Current Balances:
       - ETH: 0.000000
       - USDC: 1.000000

       Great! You now have 1 USDC in your wallet, which should be sufficient 
       for generating images using Nova Canvas. You're all set to create some images!

User: Generate an image of a futuristic city at sunset

Agent: 🎉 Success! Your futuristic city at sunset image has been generated successfully!

       Image Details:
       - Image ID: xxxx-xxxx-xxxx-xxxx
       - Cost: $0.0400 USD
       - Payment verified on Base Sepolia blockchain
       - Transaction: View on BaseScan
         https://sepolia.basescan.org/tx/0xxxx...xxxx

       [Generated Image]
```

## API Reference

### Generate Content Endpoint

**POST** `/generate`

**Headers:**
- `Content-Type: application/json`
- `PAYMENT-SIGNATURE`: Base64-encoded payment payload (required for paid requests)

**Request Body:**

```json
{
  "content": "Your prompt text",
  "model": "nova-llm" | "nova-canvas",
  "architecture": "serverless"
}
```

**Response (402 Payment Required):**

```json
{
  "scheme": "exact",
  "network": "base-sepolia",
  "maxAmountRequired": "192",
  "payTo": "0x...",
  "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "description": "AI content generation with nova-llm"
}
```

**Response (200 Success):**

```json
{
  "message": "Payment verified - content generated successfully",
  "status": "success",
  "content": "Generated text or base64 image data",
  "model": "nova-llm",
  "transactionUrl": "https://sepolia.basescan.org/tx/0x..."
}
```

### WebSocket Endpoint

**Connect:** `wss://{api-id}.execute-api.{region}.amazonaws.com/prod`

**Message Format:**

```json
{
  "input": { "prompt": "Your prompt text" },
  "session_id": "unique-session-id"
}
```

**Response Types:**
- `type: "complete"` - Contains generated content and images
- `type: "error"` - Contains error message

## Development and Testing

### Local Development

```bash
# Start frontend development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

### CDK Development

```bash
cd cdk

# Build TypeScript
npm run build

# Deploy changes
cdk deploy

# View differences before deployment
cdk diff
```

## Clean Up

To avoid incurring charges, delete all deployed resources.

### Automated Cleanup

```bash
npm run cleanup
```

### Manual Cleanup

Delete resources in reverse order of creation:

**1. Delete Amplify app (if deployed):**

```bash
APP_ID=$(aws amplify list-apps --query "apps[?name=='ai-content-monetization'].appId" --output text)
aws amplify delete-app --app-id $APP_ID
```

**2. Delete Agentic CDK stack:**

```bash
cd agentic/cdk && cdk destroy --force && cd ../..
```

**3. Delete Serverless CDK stack:**

```bash
cd serverless && cdk destroy --force && cd ..
```

**4. Delete CloudWatch log groups:**

```bash
for prefix in "/aws/lambda/AiContent" "/aws/lambda/X402" "/aws/codebuild/X402" "/aws/bedrock-agentcore/runtimes/x402_payment_agent"; do
  aws logs describe-log-groups --log-group-name-prefix "$prefix" --query 'logGroups[*].logGroupName' --output text | xargs -n1 aws logs delete-log-group --log-group-name 2>/dev/null
done
```

**5. Clean up local files:**

```bash
rm -rf node_modules/ dist/ serverless/node_modules/ serverless/cdk.out/ serverless/outputs.json serverless/lib/*.js serverless/lib/*.d.ts serverless/bin/*.js serverless/bin/*.d.ts agentic/cdk/node_modules/ agentic/cdk/cdk.out/ agentic/lambda/node_modules/
```

## Troubleshooting

### Common Issues

#### Serverless Architecture

1. **Wallet Connection Fails:**
   - Verify WalletConnect Project ID is configured in `.env`
   - Ensure browser wallet extension is installed
   - Check that Base Sepolia network is available in your wallet

2. **Payment Verification Fails:**
   - Confirm sufficient USDC balance on Base Sepolia
   - Verify wallet is connected to Base Sepolia network
   - Check browser console for detailed error messages

3. **CORS Errors:**
   - Redeploy CDK stack: `cd serverless && cdk deploy`
   - Verify API Gateway URL matches `.env` configuration

#### Agentic Architecture

4. **AccessDeniedException for AgentCore Memory:**
   - Add the AgentCore Memory permissions to the service role (see Step 6.7)
   - Verify the MEMORY_ID is correct in your environment variables

5. **CDP Wallet Connection Fails:**
   - Verify CDP_API_KEY_NAME and CDP_API_KEY_SECRET are correct
   - Check that CDP_WALLET_SECRET is properly formatted
   - Ensure you have USDC on Base Sepolia

6. **Docker Build Fails:**
   - Check CodeBuild logs in AWS Console for build errors
   - Verify ECR push permissions are configured (see Step 6.5)

#### General Issues

7. **WebSocket Connection Issues:**
   - Check WebSocket URL in `.env` matches CDK output
   - Verify DynamoDB connections table exists
   - Review CloudWatch logs for Lambda errors

8. **Content Generation Fails:**
   - Verify Bedrock model access is enabled in your AWS account
   - Check Lambda execution role has Bedrock permissions
   - Review CloudWatch logs for specific error messages

9. **Transaction Not Found:**
   - Wait 10-30 seconds for Base Sepolia confirmation
   - Verify transaction hash on [BaseScan Sepolia](https://sepolia.basescan.org)

10. **Gateway Returns 402 After Payment:**
    - Check that the x402 client is using the correct network (base-sepolia)
    - Verify the USDC contract address matches
    - Ensure the payment amount matches the required amount

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.
