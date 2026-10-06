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

`GET /config` reports which of these are missing or invalid. It does not return secret values.

The browser session cookie is `oceanrelay_session`. It does not contain the Rate Ninja access token, refresh token, or client secret. Access tokens stay in server memory. Refresh tokens are encrypted in the store. Disconnect calls Rate Ninja `POST /oauth/revoke`.

Scopes are `profile:read`, `rates:read`, and `sailings:read`. Only a contract-owner Rate Ninja account can approve. Customer accounts are denied.

## Rate Ninja admin

The Rate Ninja OAuth client redirect is `https://oceanrelay.ai/oauth/callback`. If authorize or token calls return `partner_oauth_disabled`, partner login is turned off on Rate Ninja.

## Deploying the ledger

The operator deploys `OceanRelayLedger` to ForteL2 Sepolia (chain 852). The owner key stays in Foundry's encrypted keystore on the operator's machine. It is not a Render secret. The script reads addresses only. It does not read or print a private key.

Run these from a shell that has the Foundry `bin` directory on `PATH`. Each keystore command asks for a password. Do not put a key or a password on the command line, in the repo, or in chat.

1. Install Foundry.

```sh
curl -L https://foundry.paradigm.xyz | bash
export PATH="$PATH:$HOME/.foundry/bin"
foundryup
```

2. Create the owner, relayer, and registrar keys in Foundry's encrypted keystore (`~/.foundry/keystores`).

```sh
cast wallet new owner
cast wallet new relayer
cast wallet new registrar
```

The name is required. A bare `cast wallet new` prints a private key and does not save a keystore. Do not run that. Each command above writes an encrypted keystore and prints only the address. Record the three addresses.

3. Show the relayer address.

```sh
cast wallet address --account relayer
```

4. Dry-run against local anvil. In one terminal:

```sh
anvil
```

In another, from the `contracts` directory. `OPERATOR_ADDRESSES` is optional. Leave it unset when there is no operator wallet yet. If you set it, use the operator addresses you intend to register, separated by commas.

```sh
cd contracts
export RELAYER_ADDRESS="$(cast wallet address --account relayer)"
export REGISTRAR_ADDRESS="$(cast wallet address --account registrar)"
unset OPERATOR_ADDRESSES
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --account owner
```

Success is a printed `OceanRelayLedger` address, the owner, the relayer, the registrar, each operator, and `runtimeCodeHash`. Anvil's chain id is 31337, which the script allows. Any other chain id is refused. Stop anvil when the dry run is done.

Record the printed `runtimeCodeHash`. It is `keccak256` of the deployed runtime code. Do not hash the build artifact in its place. The runtime code contains the chain id and the contract address, because OpenZeppelin's EIP-712 cache stores both as immutables. A second deploy, even of this same source, has a different hash.

5. Deploy to chain 852. Foundry 1.8.5 cannot attach custom RPC headers from `forge script`: `forge script --help` has no header flag, and setting `ETH_RPC_HEADERS` did not put the Cloudflare Access headers on the script's RPC calls. `cast send` and `cast rpc` do accept `--rpc-headers`, but this deploy is a `forge script`. Use the local proxy, which adds the two headers and does not print them.

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

`--account owner` prompts for the keystore password. The broadcast summary prints the deploy transaction hash. The script prints the address, owner, relayer, registrar, operators, and runtime-code hash.

Read the block number through the same proxy, or with `cast`, which does send headers:

```sh
cast receipt TRANSACTION_HASH --rpc-url http://127.0.0.1:8546
```

6. Open a pull request that adds `deployments/fortel2-sepolia.json`. That file is the operator's. Record:

- address
- deploy transaction hash
- block
- runtime-code hash
- owner
- relayer
- registrar
- operators

The relayer still needs test ETH on chain 852 before OceanRelay can submit transactions. Fund that address. Do not fund the registrar. The registrar signs bindings and does not send transactions.
