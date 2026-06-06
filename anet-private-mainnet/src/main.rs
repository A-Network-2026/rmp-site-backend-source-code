mod activation;
mod block;
mod consensus;
mod db;
mod dex;
mod rpc;
mod state;
mod transaction;

use std::{net::SocketAddr, path::Path, path::PathBuf, sync::Arc};

use anyhow::{Context, Result};
use clap::{CommandFactory, Parser};
use tokio::sync::RwLock;
use tokio::time::{self, Duration};

#[derive(Debug, Parser)]
#[command(
    author,
    version,
    about = "ANET Layer 1 private mainnet node with Genesis Activation"
)]
struct Cli {
    #[arg(long)]
    init_genesis: bool,

    #[arg(long)]
    start_node: bool,

    #[arg(long)]
    bootstrap: bool,

    #[arg(long)]
    genesis_path: Option<PathBuf>,

    #[arg(long)]
    chain_path: Option<PathBuf>,

    #[arg(long)]
    bind: Option<String>,

    #[arg(long)]
    epoch_seconds: Option<u64>,
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    init_tracing();

    let cli = Cli::parse();
    if !cli.init_genesis && !cli.start_node && !cli.bootstrap {
        Cli::command().print_help()?;
        println!();
        return Ok(());
    }

    let genesis_path = resolve_path(cli.genesis_path, "ANET_GENESIS_PATH", "config/genesis.json");
    let chain_path = resolve_path(cli.chain_path, "ANET_CHAIN_PATH", "data/chain.json");

    let mut genesis = None;

    if cli.init_genesis {
        let generated = activation::activate_genesis(&genesis_path).await?;
        tracing::info!(path = %genesis_path.display(), accounts = generated.accounts.len(), "completed Genesis Activation from the Ant Ledger");
        genesis = Some(generated);
    }

    if cli.bootstrap {
        let loaded = match genesis.clone() {
            Some(genesis) => genesis,
            None if genesis_path.exists() => activation::load_genesis(&genesis_path)?,
            None => activation::activate_genesis(&genesis_path).await?,
        };
        let loaded = migrate_genesis_chain_id_if_needed(loaded, &genesis_path)?;
        state::bootstrap_chain_store(&loaded, &chain_path).await?;
        tracing::info!("loaded PostgreSQL chain storage");
        genesis = Some(loaded);
    }

    if cli.start_node {
        let loaded = match genesis {
            Some(genesis) => genesis,
            None if genesis_path.exists() => activation::load_genesis(&genesis_path)?,
            None => activation::activate_genesis(&genesis_path).await?,
        };
        let loaded = migrate_genesis_chain_id_if_needed(loaded, &genesis_path)?;

        let epoch_seconds = resolve_epoch_seconds(cli.epoch_seconds)?;

        let mut node_state = state::NodeState::from_genesis(
            loaded,
            genesis_path.clone(),
            chain_path.clone(),
            epoch_seconds,
        )
        .await?;
        match load_postgres_sync_data().await {
            Ok((activated_accounts, validators)) => {
                let sync = node_state.sync_activated_accounts(activated_accounts)?;
                node_state.mark_web2_sync_success();
                if sync.accounts_updated > 0 {
                    tracing::info!(
                        accounts_updated = sync.accounts_updated,
                        credited_ants = sync.credited_ants,
                        "applied startup Web2 activation sync"
                    );
                }
                if !validators.is_empty() {
                    node_state.replace_validators(validators);
                } else {
                    tracing::warn!("no eligible validators were returned by PostgreSQL");
                }
            }
            Err(error) => {
                node_state.mark_web2_sync_failure(error.to_string());
                tracing::warn!(
                    ?error,
                    "postgres sync unavailable; starting from local activated snapshot"
                );
            }
        }

        let shared_state = Arc::new(RwLock::new(node_state));
        let consensus_state = shared_state.clone();
        tokio::spawn(async move {
            if let Err(error) = consensus::run_consensus(consensus_state, epoch_seconds).await {
                tracing::error!(?error, "consensus loop exited");
            }
        });

        if let Some(sync_interval_seconds) = sync_interval_seconds()? {
            let sync_state = shared_state.clone();
            tokio::spawn(async move {
                let mut interval = time::interval(Duration::from_secs(sync_interval_seconds));
                interval.tick().await;
                loop {
                    interval.tick().await;
                    match load_postgres_sync_data().await {
                        Ok((activated_accounts, validators)) => {
                            let mut state = sync_state.write().await;
                            match state.sync_activated_accounts(activated_accounts) {
                                Ok(sync) => {
                                    state.mark_web2_sync_success();
                                    if !validators.is_empty() {
                                        state.replace_validators(validators);
                                    }
                                    if sync.accounts_updated > 0 {
                                        tracing::info!(
                                            accounts_updated = sync.accounts_updated,
                                            credited_ants = sync.credited_ants,
                                            "applied periodic Web2 activation sync"
                                        );
                                    }
                                }
                                Err(error) => {
                                    state.mark_web2_sync_failure(error.to_string());
                                    tracing::warn!(
                                        ?error,
                                        "failed to apply periodic Web2 activation sync"
                                    );
                                }
                            }
                        }
                        Err(error) => {
                            let mut state = sync_state.write().await;
                            state.mark_web2_sync_failure(error.to_string());
                            tracing::warn!(?error, "failed to load PostgreSQL sync data");
                        }
                    }
                }
            });
        }

        let bind_addr = resolve_bind_addr(cli.bind)?;
        rpc::run_server(shared_state, bind_addr).await?;
    }

    Ok(())
}

fn migrate_genesis_chain_id_if_needed(
    mut genesis: activation::GenesisConfig,
    genesis_path: &Path,
) -> Result<activation::GenesisConfig> {
    let desired_chain_id = std::env::var("ANET_CHAIN_ID")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| activation::CHAIN_ID.to_owned());

    if genesis.chain_id == desired_chain_id {
        return Ok(genesis);
    }

    let previous_chain_id = genesis.chain_id.clone();
    genesis.chain_id = desired_chain_id.clone();
    activation::write_genesis(genesis_path, &genesis)?;
    tracing::warn!(
        previous_chain_id = %previous_chain_id,
        new_chain_id = %desired_chain_id,
        path = %genesis_path.display(),
        "updated persisted genesis chain_id to match private-mainnet configuration"
    );

    Ok(genesis)
}

fn resolve_bind_addr(bind: Option<String>) -> Result<SocketAddr> {
    let default_port = std::env::var("PORT").unwrap_or_else(|_| "8080".to_owned());
    let bind = bind.unwrap_or_else(|| format!("0.0.0.0:{default_port}"));
    bind.parse()
        .with_context(|| format!("failed to parse bind address {bind}"))
}

fn resolve_epoch_seconds(epoch_seconds: Option<u64>) -> Result<u64> {
    if let Some(epoch_seconds) = epoch_seconds {
        return validate_epoch_seconds(epoch_seconds);
    }

    let value = std::env::var("ANET_BLOCK_TIME_SECONDS")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::var("ANET_EPOCH_SECONDS")
                .ok()
                .filter(|value| !value.trim().is_empty())
        });

    match value {
        Some(value) => {
            let parsed = value.parse::<u64>().with_context(|| {
                format!(
                    "failed to parse ANET_BLOCK_TIME_SECONDS or ANET_EPOCH_SECONDS value {value}"
                )
            })?;
            validate_epoch_seconds(parsed)
        }
        None => Ok(consensus::DEFAULT_EPOCH_SECONDS),
    }
}

fn validate_epoch_seconds(epoch_seconds: u64) -> Result<u64> {
    if epoch_seconds == 0 {
        anyhow::bail!("epoch seconds must be greater than zero")
    }

    Ok(epoch_seconds)
}

fn init_tracing() {
    let filter =
        std::env::var("RUST_LOG").unwrap_or_else(|_| "info,anet_private_mainnet=info".to_owned());
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .compact()
        .init();
}

async fn load_postgres_sync_data() -> Result<(Vec<activation::GenesisAccount>, Vec<String>)> {
    let client = db::connect().await?;
    let activated_accounts = db::load_genesis_accounts(&client)
        .await?
        .into_iter()
        .map(|row| activation::GenesisAccount {
            address: row.wallet_address,
            ants_balance: row.ants_balance,
            sessions: row.sessions,
            total_activated_ants: row.ants_balance,
        })
        .collect();
    let validators = db::load_eligible_validators(&client).await?;
    Ok((activated_accounts, validators))
}

fn sync_interval_seconds() -> Result<Option<u64>> {
    let raw = std::env::var("ANET_WEB2_SYNC_SECONDS").unwrap_or_else(|_| "60".to_owned());
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Some(60));
    }
    let seconds = trimmed
        .parse::<u64>()
        .with_context(|| format!("failed to parse ANET_WEB2_SYNC_SECONDS={trimmed}"))?;
    if seconds == 0 {
        return Ok(None);
    }
    Ok(Some(seconds))
}

fn resolve_path(path: Option<PathBuf>, env_key: &str, default: &str) -> PathBuf {
    path.or_else(|| {
        std::env::var_os(env_key)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    })
    .unwrap_or_else(|| PathBuf::from(default))
}
