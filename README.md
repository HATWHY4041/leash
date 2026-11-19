# Leash — an AI payment assistant on a leash

> Tell it who to pay in plain English. A smart contract on **QDay Aevum Testnet** makes sure it can never overspend.

**Track:** Native AI Assistants · **Aevum Builder Challenge #1** · stablecoin: **tUSD8**

🔗 **Live demo:** https://leash-aevum.vercel.app · health check: [/api/health](https://leash-aevum.vercel.app/api/health)
📜 **Contract:** [`contracts/LeashVault.sol`](contracts/LeashVault.sol)
🧪 **Tests:** `npm test` (16 passing)

---

## The problem

AI assistants are getting good at doing real tasks, and paying for things is the obvious next step: settling invoices, paying freelancers, topping up a supplier. Today there are two bad options:

1. **Give the AI your wallet key.** If the model makes a mistake, gets tricked by a prompt injection, or the key leaks, everything in the wallet is gone.
2. **Approve every payment yourself.** Safe, but then the assistant isn't saving you any time.

Businesses already solved this for human staff with corporate cards: a spending limit, an approved list of vendors, and a manager who signs off big purchases. AI agents need the same thing, but **enforced by code, not by trusting the AI.**

## The solution

Leash splits the assistant's power in two:

- **The AI proposes.** You type *"pay Tunde 2 for the logo"*. An LLM turns that into a structured payment intent.
- **The contract disposes.** The assistant has its own key, and that key can only call one function on your **LeashVault**: `agentPay`. The vault checks every rule on-chain before a single tUSD8 moves.

| Rule (on-chain) | What it stops |
|---|---|
| **Payee allowlist** | The AI can only pay addresses *you* approved. A prompt-injected "send everything to 0xHacker" is impossible. |
| **Daily limit** | A hard cap per rolling 24 hours, no matter how many times the AI is asked. |
| **Approval threshold** | Any single payment above it is *filed as a request*, not paid. You approve or reject it with your own wallet. |
| **24h request expiry** | Old requests can't be approved by accident days later. |
| **Kill switch** | `setPaused(true)` freezes the assistant instantly. |
| **Key rotation / revoke** | Swap or remove the AI key at any time; the old key becomes useless. |

**Worst case, even if the AI key is stolen:** an attacker can send at most your daily limit, only to people you already trust. That's the leash.

## How it works

```
 You (chat)                Browser                         Aevum Testnet
 ──────────                ───────                         ─────────────
 "pay Tunde 2         ┌─► /api/parse (LLM via Vercel AI Gateway)
  for the logo"  ─────┤     → {intent:"pay", payee:"Tunde", amount:2, memo:"logo"}
                      │   (falls back to a built-in parser if AI is unavailable)
                      │
                      ├─► re-validate against the on-chain payee list
                      ├─► show a "leash check" card (allowlist / threshold / limit / balance / pause)
                      │
                      └─► assistant key signs  LeashVault.agentPay(Tunde, 2, "logo")
                                                         │
                                         ┌───────────────┴───────────────┐
                                  rules pass                        rule fails
                          tUSD8.transfer → Tunde           PaymentRequested event
                          AgentPaid event                  (owner approves / rejects
                                                            from their own wallet)
```

### Components

| Part | File | Notes |
|---|---|---|
| Smart contract | `contracts/LeashVault.sol` | One vault per user. Holds tUSD8 (`0x4565…3483`, 6 decimals). Owner = your wallet. Agent = the assistant's key. No admin, no upgradeability, no external dependencies. |
| Web app | `index.html`, `src/` | Vanilla JS + viem. Deploys your vault from your wallet, manages payees, approvals, limits, kill switch, deposits/withdrawals, and shows the on-chain activity log. |
| AI intent parser | `api/parse.js`, `api/_llm.js` | Serverless function. Calls an LLM (Groq / any OpenAI-compatible API, or Vercel AI Gateway). Returns JSON only. Has no keys and cannot move funds. The system prompt treats the user message as data and ignores instructions to change rules. |
| Local fallback parser | `src/parser.js` | Rule-based, so the demo works even with no AI available. Output from either parser is re-checked against the on-chain payee list. |
| RPC proxy | `api/rpc.js` | Forwards an allowlist of read + `eth_sendRawTransaction` calls to `https://rpc-test.qday.info`. It never sees a private key. |

### Core workflows

1. **Create a vault.** Connect your wallet → Leash adds the Aevum network (chain ID 44005) → you pick a daily limit and an "ask me above" amount → the app generates a fresh assistant key in your browser, deploys `LeashVault` from your wallet, and sends the assistant 0.5 tQDAY for gas.
2. **Fund it.** Deposit tUSD8 from your wallet (get some from the [QDay faucet](https://faucet.qday.info/en)).
3. **Approve payees.** Add names + addresses. They are stored in the contract.
4. **Chat.** "pay Tunde 2 for the logo" → instant payment if all rules pass. "send 5 to Tunde for the website" → above threshold → filed as request #N.
5. **Approve.** In *Approvals*, approve (pays) or reject. Requests expire after 24h.
6. **Pull the leash.** *Rules* → Pause, rotate the key, revoke the assistant, change limits, withdraw.
7. **Audit.** *Activity* reads every vault event straight from Aevum, with explorer links.

## Safety, trust and controls

- **The AI never has the power to break the rules.** Limits live in the contract, not in the prompt. Prompt injection can at most cause a payment to an already-approved payee within limits, which is exactly what the owner allowed.
- **Least privilege keys.** The assistant key can call only `agentPay`. Every other function is `onlyOwner`.
- **Separation of concerns.** Your main wallet never signs routine payments; the assistant key never holds funds (only gas).
- **Defence in depth in the app.** The parser's output is sanitized (amount, 60-char memo, control chars stripped) and the payee must match the on-chain list exactly. Every payment is simulated before it is sent. The user sees a check card for each rule. There is an optional "confirm every payment" switch.
- **Contract hygiene.** Custom errors, a reentrancy guard on all fund-moving functions, safe ERC-20 transfer handling, a threshold ≤ daily-limit invariant, no `delegatecall`, no proxies, compiled for `paris` EVM.
- **Known limits (testnet MVP).** The assistant key is stored in the browser's localStorage. For production it should live in a secure enclave or a server-side signer with its own rate limits. The daily limit is a rolling window that starts at the first payment after it resets.

## Running it yourself

```bash
npm install
npm test          # compiles LeashVault + runs 16 contract tests on a local chain
npm run dev       # http://localhost:5173 (proxies RPC to Aevum Testnet)
npm run build     # production build in dist/
```

Deploy to Vercel as-is: the `api/` folder becomes serverless functions.

AI parsing (`api/_llm.js`) works with either:
- **Any OpenAI-compatible API**: set `LLM_API_KEY` (defaults to Groq's free tier; override with `LLM_BASE_URL`, `LLM_MODEL`), or
- **Vercel AI Gateway**: OIDC auth on Vercel or `AI_GATEWAY_API_KEY`; model via `LEASH_MODEL` (default `openai/gpt-4.1-mini`).

With no AI configured, the built-in parser takes over automatically. Optional: `AEVUM_RPC_URL`.

### Aevum Testnet details

| | |
|---|---|
| Network | QDay Aevum Testnet |
| Chain ID | 44005 |
| RPC | https://rpc-test.qday.info |
| Explorer | https://explorer-test.qday.info |
| Gas token | tQDAY ([faucet](https://faucet.qday.info/en)) |
| tUSD8 | `0x456569838f1d43009A91ebA4263147Afd7233483` (ERC-20, 6 decimals) |

### Deployed instances

| What | Address / tx |
|---|---|
| Demo LeashVault | _add after first deploy from the live app_ |
| Example agent payment tx | _add_ |
| Example approval tx | _add_ |

## Tests

`scripts/test.mjs` runs the contract on an in-memory chain:

```
LeashVault
  ✓ rejects bad limits at deploy (threshold > daily)
  ✓ agent cannot pay someone who is not an approved payee
  ✓ only owner can approve payees
  ✓ agent pays instantly when within limits
  ✓ strangers cannot use the agent function
  ✓ payment above threshold becomes a request, no money moves
  ✓ payment that would break the daily limit becomes a request
  ✓ owner approves a request and it pays
  ✓ owner rejects a request and nothing moves
  ✓ kill switch stops the agent completely
  ✓ removing a payee blocks payments and pending approvals to them
  ✓ daily window resets after 24h
  ✓ pending requests expire after 24h
  ✓ owner can revoke the agent key
  ✓ owner can change limits but not to invalid values
  ✓ only owner can withdraw

16 passing
```

The full UI was also tested end to end in a headless browser against a local chain: deploy → add payee → deposit → instant AI payment → over-threshold request → owner approval → kill switch → activity log.

## Tech

Solidity 0.8.26 · viem · Vite · Vercel serverless functions · LLM via OpenAI-compatible API or Vercel AI Gateway · QDay Aevum Testnet · tUSD8

## License

MIT — see [LICENSE](LICENSE). Third-party packages are listed in [NOTICE.md](NOTICE.md).

Built during Aevum Builder Challenge #1 (Nov 16 – Dec 11, 2026) by [@ayoadhe](https://x.com/ayoadhe).
