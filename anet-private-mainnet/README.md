# ANET Layer 1 Private Mainnet

Rust-based ANET Layer 1 private-mainnet node for A-Network. It performs Genesis Activation from the Web2 Ant Ledger into `config/genesis.json`, keeps ledger accounting in ANTS, displays balances in ANET, runs a fee-only Time-Based Proof-of-Work (TPoW) chain on fast transfer epochs, and can continuously settle newly mined Web2 ANTS into the running network.

## Design rules

- `1 completed session = 4,882,812 ANTS`
- `100,000,000 ANTS = 1 ANET`
- No new ANET minting exists on this private mainnet
- The Ant Ledger becomes the chain at Genesis Activation
- Web2 miners still complete 6-hour proof-of-time sessions in the backend
- Layer 1 transfer blocks can run independently at a much faster cadence
- After startup, new Web2 mining balance can be activated into the running chain as incremental ANTS settlements once the wallet reaches 1,000 completed Web2 sessions
- Validators and ANET activation require at least 1,000 completed Web2 sessions, plus no delete, ban, or flag status
- For durable deployments, keep both `genesis.json` and `chain.json` on persistent storage so redeploys do not restart the ledger from block `#0`

## Web2 sync behavior

- Genesis Activation imports the current Web2 ledger snapshot into `config/genesis.json`
- After the node starts, it can poll PostgreSQL and settle only the newly mined Web2 ANTS delta for each wallet
- Wallets below 1,000 completed Web2 sessions are not activated into Layer 1 yet and cannot send or receive ANET on Layer 1
- On upgrade, legacy under-1,000 wallets lose their remaining Web2-derived activated ANET, while transferred-in on-chain funds remain intact
- The node tracks how much Web2 balance has already been activated, so on-chain spending is not re-credited on the next sync
- Set `ANET_WEB2_SYNC_SECONDS=0` to disable periodic sync; default is `60` seconds
- `ANET_GENESIS_PATH` and `ANET_CHAIN_PATH` let you move the node state onto a persistent volume without changing CLI commands

## Commands

```bash
cargo run -- --init-genesis
cargo run -- --bootstrap
cargo run -- --start-node
cargo run -- --bootstrap --start-node
```

If Rust is not installed locally, you can still build the node through Docker or GitHub Actions.

## Environment

Use `.env.example` as the template for PostgreSQL and runtime settings.

## API

- `GET /health`
- `GET /ready`
- `GET /blocks`
- `GET /blocks/:id`
- `GET /blocks/height/:height`
- `GET /accounts/:address`
- `POST /transactions`
- `GET /web2/account/:address`
- `GET /account/full/:address`

Native DEX API (Layer 1):

- `GET /dex/pools`
- `GET /dex/pools/:symbol`
- `POST /dex/assets/mint` (private-mainnet bootstrap; requires `ANET_DEX_ADMIN_KEY`)
- `POST /dex/pools/create`
- `POST /dex/pools/add-liquidity`
- `POST /dex/swap/quote`
- `POST /dex/swap/execute`

Notes:

- DEX actions are wallet-seed authorized in the same way as transfers.
- Wallet must have at least `1,000` completed sessions to use DEX routes.
- DEX pools are native to this Layer 1 node and use ANET (ANTS units) against an additional network asset symbol (example: `USDA`).

Create pool payload example:

```json
{
  "provider": "ANET1234567890ABCDEF1234567890ABCDEF1234",
  "sender_seed": "your 12 word ANET wallet seed phrase",
  "token_symbol": "USDA",
  "anet_amount_ants": 500000000,
  "token_amount_units": 500000,
  "fee_bps": 30
}
```

Swap quote payload example:

```json
{
  "token_symbol": "USDA",
  "amount_in": 10000000,
  "anet_to_token": true
}
```

## Explorer

- `/explorer` dashboard
- `/explorer/miners` gated miner portal inside the existing explorer
- `/explorer/build` gated builder and ecosystem portal with ANET-denominated commercial surfaces
- `/explorer/blocks`
- `/explorer/blocks/:height`
- `/explorer/accounts/:address`
- dashboard includes a Colony Transfer form that posts to `/transactions`

Example transaction payload:

```json
{
  "from": "ANET1234567890ABCDEF1234567890ABCDEF1234",
  "to": "ANETFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
  "amount_ants": 1000,
  "fee_ants": 10,
  "sender_seed": "your 12 word ANET wallet seed phrase"
}
```

The current private mainnet keeps compatibility with the existing Web2 ANET wallet model, so transfer authorization is seed-based for now. The long-term next step is a proper public-key signature migration.

## GitHub fork + Render quick start

If you want to run this from your fork of `https://github.com/A-Network-2026/anet-chain`, use this order:

1. Fork the repository into your own GitHub account.
2. In the fork settings, keep the default branch as `main`.
3. In Render, create a new `Web Service` from that forked repository.
4. Set the Root Directory to `A Network/anet-private-mainnet` if Render asks for a subdirectory.
5. Render can use the included `render.yaml`, or you can enter the same values manually.

Manual Render values:

```text
Environment: Rust
Build Command: cargo build --release
Start Command: ./target/release/anet-private-mainnet --bootstrap --start-node
Health Check Path: /health
```

Required environment variables:

```text
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DBNAME
PGSSLMODE=require
RUST_LOG=info
PORT=10000
ANET_EPOCH_SECONDS=2
ANET_WEB2_SYNC_SECONDS=60
ANET_EXPLORER_DASHBOARD_CACHE_MS=5000
ANET_EXPLORER_DASHBOARD_SOFT_TIMEOUT_MS=1500
ANET_EXPLORER_DASHBOARD_BACKOFF_MS=10000
ANET_EXPLORER_ROOM_BOT_GUARD=true
ANET_DEX_ADMIN_KEY=replace-with-long-random-secret
ANET_GENESIS_PATH=/var/data/anet/config/genesis.json
ANET_CHAIN_PATH=/var/data/anet/data/chain.json
```

Notes:

- `DATABASE_URL` must point to the same PostgreSQL instance that holds your A-Network `users` table.
- `PGSSLMODE=require` is the right setting for hosted PostgreSQL on Render or most managed providers.
- `ANET_EPOCH_SECONDS=2` is the default fast transfer-block cadence. This does not change the 6-hour Web2 mining session duration.
- `ANET_EXPLORER_DASHBOARD_CACHE_MS=5000` keeps the hot dashboard metrics endpoint responsive by reusing the last in-process snapshot for 5 seconds between refreshes.
- `ANET_EXPLORER_DASHBOARD_SOFT_TIMEOUT_MS=1500` limits how long the HTML `/explorer` page will wait for production metrics before falling back to chain-only cards, preventing 8-second page stalls when PostgreSQL is slow.
- `ANET_EXPLORER_DASHBOARD_BACKOFF_MS=10000` pauses repeated dashboard metrics DB attempts for a short cooldown after timeout/error, preventing every request from paying the full soft-timeout during temporary PostgreSQL degradation.
- `ANET_EXPLORER_ROOM_BOT_GUARD=true` short-circuits known aggressive crawler scans on sequential `/explorer/rooms/referral-room-####` keys to avoid repeated DB lookup pressure.
- `ANET_EXPLORER_DETAIL_CACHE_MS=10000` keeps repeated territory, colony, room, and Web2 account drilldowns fast by reusing the last in-process detail snapshot for 10 seconds.
- On Render, attach a persistent disk and point both `ANET_GENESIS_PATH` and `ANET_CHAIN_PATH` into that mounted path so block history and activated snapshots survive redeploys.
- Render will inject its own `PORT`; if so, that runtime value overrides the example above.

## Run locally

```bash
cp .env.example .env
cargo run -- --bootstrap --start-node
```

Then open:

- `http://127.0.0.1:8080/health`
- `http://127.0.0.1:8080/ready`
- `http://127.0.0.1:8080/explorer`

## Render

The included `render.yaml` builds the Rust service, starts it with `--bootstrap --start-node`, and mounts a persistent disk at `/var/data/anet`. Render will inject `PORT`, and the node binds to `0.0.0.0:$PORT` automatically when `--bind` is not set. Local development defaults to port `8080`.

## Docker

Build the container:

```bash
docker build -t anet-private-mainnet .
```

Run the node with PostgreSQL settings:

```bash
docker run --rm -p 8080:8080 --env-file .env anet-private-mainnet
```

The container starts the node with `--bootstrap --start-node` and persists chain data under `/app/data` inside the container.

## CI

GitHub Actions workflow `.github/workflows/anet-private-mainnet-ci.yml` runs on private-mainnet changes and performs:

- `cargo fmt --check`
- `cargo clippy -D warnings`
- `cargo build --release`
- upload of the Linux release binary as a workflow artifact
- `docker build`

## Releases and GHCR

GitHub Actions workflow `.github/workflows/anet-private-mainnet-release.yml` publishes deployable outputs:

- on `main`, it builds and pushes the container image to `ghcr.io/<owner>/anet-private-mainnet`
- on version tags like `v1.0.0`, it also publishes `anet-private-mainnet-linux-amd64.tar.gz` as a GitHub release asset
- every release workflow run uploads the bundled binary plus config as a workflow artifact

Pull the published container image:

```bash
docker pull ghcr.io/<owner>/anet-private-mainnet:latest
```

## Production notes

- `ANET_EPOCH_SECONDS` can override the default fast transfer-block cadence.
- Chain persistence is atomically written to `data/chain.json` and validated against `chain_id`, `genesis_time`, hash linkage, and epoch ordering on startup.
- `/health` is a lightweight liveness endpoint; `/ready` reports service readiness and PostgreSQL reachability.