# OceanRelay

OceanRelay connects a contract-owner Rate Ninja account. The Rate Ninja OAuth client may still be named Capacity Exchange.

`npm start` runs the HTTP service on `0.0.0.0:$PORT`. `GET /health` returns `{"status":"ok"}`. `GET /assets/oceanrelay.css` serves the shared stylesheet; `?v=` is its SHA-256.

## Environment variables

Set these on the server. Do not commit the values.

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | yes | Listen port. Render sets this. |
| `RATE_NINJA_CLIENT_ID` | yes | OAuth client id from the Rate Ninja admin screen. |
| `RATE_NINJA_CLIENT_SECRET` | yes | Confidential client secret. Stays on the server. |
| `OCEANRELAY_REDIRECT_URI` | yes | Registered callback. Production value: `https://oceanrelay.ai/oauth/callback`. Local callbacks may be `http://localhost` or `http://127.0.0.1`. |
| `SESSION_SECRET` | yes | Signs the OceanRelay session cookie. |
| `TOKEN_ENCRYPTION_KEY` | yes | Encrypts refresh tokens at rest. |
| `RATE_NINJA_BASE_URL` | no | Defaults to `https://rateninja.co`. |
| `OCEANRELAY_STORE_PATH` | no | Encrypted token store. Defaults to `data/oceanrelay-store.json`. On Render, point this at a persistent disk because the service filesystem is ephemeral. |
| `OCEANRELAY_RECORDS_PATH` | no | Offers and the audit log. Defaults to `data/oceanrelay-records.json`. Separate from the token store. On Render, point this at the same persistent disk. |
| `OCEANRELAY_OPERATOR_SUBS` | no | Comma-separated Rate Ninja user ids allowed to open operator screens. `/config` shows only the count. |
| `OCEANRELAY_RELAYER_KEY` | with the other three chain secrets | Relayer private key. It signs transactions. |
| `OCEANRELAY_REGISTRAR_KEY` | with the other three chain secrets | Registrar private key. It signs wallet bindings and does not send transactions. |
| `CF_ACCESS_CLIENT_ID` | with the other three chain secrets | Cloudflare Access client id for the write RPC. |
| `CF_ACCESS_CLIENT_SECRET` | with the other three chain secrets | Cloudflare Access client secret for the write RPC. |
| `FORTEL2_READ_RPC` | no | Sequencer reads. Defaults to `https://fortel2-sequencer-rpc.onrender.com/`. |
| `FORTEL2_WRITE_RPC` | no | Authenticated writes. Defaults to `https://fortel2-write.ente.ltd`. OceanRelay uses it only for `eth_sendRawTransaction`. |
| `OCEANRELAY_CHAIN_MAX_FEE_GWEI` | no | Cap on `maxFeePerGas`, in gwei. Defaults to `1`. |

`GET /config` reports which of these are missing or invalid. It does not return secret values. With none of the four chain secrets set, `chain.state` is `disabled`. With some of them set, `chain.state` is `misconfigured` and `chain.reason` is `incomplete`. When the startup check matches the deployed ledger, `chain.state` is `ready`.

The browser session cookie is `oceanrelay_session`. It does not contain the Rate Ninja access token, refresh token, or client secret. Access tokens stay in server memory. Refresh tokens are encrypted in the store. Disconnect calls Rate Ninja `POST /oauth/revoke`.

Scopes are `profile:read`, `rates:read`, and `sailings:read`. Only a contract-owner Rate Ninja account can approve. Customer accounts are denied.

## Rate Ninja admin

The Rate Ninja OAuth client redirect is `https://oceanrelay.ai/oauth/callback`. If authorize or token calls return `partner_oauth_disabled`, partner login is turned off on Rate Ninja.

## Deploying the ledger

The operator deploys `OceanRelayLedger` to ForteL2 Sepolia (chain 852). The owner key stays in Foundry's encrypted keystore on the operator's machine. It is not a Render secret. The script reads addresses only. It does not read or print a private key.

A new terminal does not keep Foundry on `PATH`. Run this in every new window, or add it to your shell profile, before any `forge` or `cast` command:

```sh
export PATH="$PATH:$HOME/.foundry/bin"
```

Each keystore command asks for a password. `cast wallet address --account NAME` and `cast wallet private-key --account NAME` ask for NAME's password. Do not put a key or a password on the command line, in the repo, or in chat.

1. Install Foundry, then install the Solidity dependencies. `forge build` and `forge script` need that install first.

```sh
curl -L https://foundry.paradigm.xyz | bash
export PATH="$PATH:$HOME/.foundry/bin"
foundryup
cd contracts
forge soldeer install
```

2. Create the owner, relayer, and registrar keys in Foundry's encrypted keystore (`~/.foundry/keystores`).

```sh
cast wallet new owner
cast wallet new relayer
cast wallet new registrar
```

The name is required. A bare `cast wallet new` prints a private key and does not save a keystore. Do not run that. Each command above writes an encrypted keystore and prints only the address. Record the three addresses.

3. Show an address. This prompts for that account's password:

```sh
cast wallet address --account relayer
```

4. Put test ETH on chain 852 before the deploy. The owner pays for the deployment transaction. The public sequencer refuses `eth_sendRawTransaction`, so a transfer sent to the public RPC does not arrive. Deposit from Ethereum Sepolia through the L1StandardBridge at `0x113AAd08047E9a9B1556627A658f87F0EbEf85a7`. The call is `depositETHTo(addr, 200000, 0x)`: the address that should receive the ETH on chain 852, a minimum gas limit of 200000, and empty extra data. The transaction value is the amount of ETH to deposit. Send it on Sepolia, from the owner key, once to the owner address and once to the relayer address. Do not fund the registrar. The registrar signs bindings and does not send transactions.

5. Dry-run against local anvil. In one terminal:

```sh
anvil
```

In another, from the `contracts` directory. `OPERATOR_ADDRESSES` is optional. Leave it unset when there is no operator wallet yet. If you set it, use the operator addresses you intend to register, separated by commas. Each `cast wallet address` below prompts for that account's password.

```sh
cd contracts
export RELAYER_ADDRESS="$(cast wallet address --account relayer)"
export REGISTRAR_ADDRESS="$(cast wallet address --account registrar)"
unset OPERATOR_ADDRESSES
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --account owner
```

Success is a printed `OceanRelayLedger` address, the owner, the relayer, the registrar, each operator, and `runtimeCodeHash`. Anvil's chain id is 31337, which the script allows. Any other chain id is refused. Stop anvil when the dry run is done.

Record the printed `runtimeCodeHash`. It is `keccak256` of the deployed runtime code. Do not hash the build artifact in its place. The runtime code contains the chain id and the contract address, because OpenZeppelin's EIP-712 cache stores both as immutables. A second deploy, even of this same source, has a different hash.

6. Deploy to chain 852. The owner address needs the test ETH from the deposit above. Foundry 1.8.5 cannot attach custom RPC headers from `forge script`: `forge script --help` has no header flag, and setting `ETH_RPC_HEADERS` did not put the Cloudflare Access headers on the script's RPC calls. `cast send` and `cast rpc` do accept `--rpc-headers`, but this deploy is a `forge script`. Use the local proxy, which adds the two headers and does not print them.

In one terminal, from `contracts`:

```sh
cd contracts
export FORTEL2_WRITE_RPC="https://fortel2-write.ente.ltd"
export CF_ACCESS_CLIENT_ID="the Access client id"
export CF_ACCESS_CLIENT_SECRET="the Access client secret"
node script/access-proxy.js
```

In another, still in `contracts`, with the same address variables as the dry run:

```sh
cd contracts
export RELAYER_ADDRESS="$(cast wallet address --account relayer)"
export REGISTRAR_ADDRESS="$(cast wallet address --account registrar)"
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8546 --broadcast --account owner
```

`--account owner` prompts for the owner's keystore password. The broadcast summary prints the deploy transaction hash. The script prints the address, owner, relayer, registrar, operators, and runtime-code hash.

Read the block number through the same proxy, or with `cast`, which does send headers:

```sh
cast receipt TRANSACTION_HASH --rpc-url http://127.0.0.1:8546
```

7. Open a pull request that adds `deployments/fortel2-sepolia.json`. That file is the operator's. Record:

- address
- deploy transaction hash
- block
- runtime-code hash
- owner
- relayer
- registrar
- operators

## Adding the chain secrets to Render

OceanRelay does not use the ledger until the four chain secrets are set on the Render service. Do this after the deployment pull request is merged. Print each key once, paste it into Render, and clear the terminal. Do not save a key to a file, the repo, or chat.

```sh
export PATH="$PATH:$HOME/.foundry/bin"
cast wallet private-key --account relayer
```

That prompts for the relayer password and prints the relayer key. Paste it into the Render environment variable `OCEANRELAY_RELAYER_KEY`. Then run `clear`, or close the terminal.

```sh
cast wallet private-key --account registrar
```

Paste that into `OCEANRELAY_REGISTRAR_KEY`, then clear the terminal again.

The other two variables are the Cloudflare Access service token:

- `CF_ACCESS_CLIENT_ID`
- `CF_ACCESS_CLIENT_SECRET`

Leave `FORTEL2_READ_RPC`, `FORTEL2_WRITE_RPC`, and `OCEANRELAY_CHAIN_MAX_FEE_GWEI` unset to use the defaults. Saving the variables restarts the service. When the check matches the deployed ledger, `GET /config` shows `"chain": { "state": "ready" }` and does not include a key or an Access secret.

## Binding a wallet

A signed-in user opens `/wallet` to bind a browser wallet to their company. The page lists the company's wallets. Each row shows the address, a state, the date, and, when there is a transaction hash, a link to the explorer.

Prepare creates the company key. It does not send a transaction. Connect and sign asks the browser wallet to sign the binding. The registrar co-signs, and the relayer sends it. The wallet asks to switch to ForteL2 Sepolia, or to add that network if the wallet does not know it. The user still needs no ETH, because the wallet only signs and the relayer sends the transaction. Without a browser wallet, or without JavaScript, the page explains that and binds nothing.

Check pending is the only way a submitting or pending binding moves on. Opening the page does not ask the chain.

A company can have at most five wallets that are submitting, pending, or confirmed, and only one binding in progress. The relayer address and the registrar address cannot be bound.

States:

- **Submitting.** The binding is recorded and is being sent.
- **Pending.** The transaction was sent and is not confirmed yet. Pending is not a failure.
- **Confirmed.** The wallet is bound to the company.
- **Reverted.** The transaction was mined and did not succeed.
- **Refused.** The chain refused the binding.
- **Expired.** The deadline passed before the binding was confirmed.

When the chain is not ready, the page says binding is unavailable and offers no action.

## Recording an offer on chain

Recording is optional, and only for a draft. The seller opens the offer and chooses Publish on chain. That page prepares a random offer key and a random salt, then asks the seller's bound wallet to sign. The relayer sends the transaction. The salt never leaves OceanRelay. The chain stores a commitment, not the price, the markup, the company, or the customer.

After the first record, later versions are signed in order, then a pause or a resume. Expiry is recorded from the chain page with Check, and it does not need a signature. Opening the page does not ask the chain.

What is recorded: the offer key, the version, a commitment to the buyer-visible terms, the expiry, and published, paused, or expired. What is not recorded: the base price, the markup, the rate snapshot, and any name or id.

States:

- **Submitting.** The action is recorded here and is being sent.
- **Pending.** The transaction was sent and is not confirmed yet. Pending is not a failure.
- **Confirmed.** The chain has this action.
- **Reverted.** The transaction was mined and did not succeed.
- **Refused.** The chain refused the action. A refused publish can be signed again.
- **Expired.** The signature deadline passed before the action was confirmed. It can be signed again.

When the chain is not ready, the page says recording is unavailable, and publishing, editing, and pausing still work off chain.
