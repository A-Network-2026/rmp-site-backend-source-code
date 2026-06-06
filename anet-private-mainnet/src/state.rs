use std::{collections::HashMap, path::PathBuf, sync::Arc};

use anyhow::{anyhow, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::{
    activation::{GenesisConfig, ANTS_PER_ANET},
    block::Block,
    db,
    dex::{self, DexLiquidityResult, DexPool, DexPoolView, DexQuoteView, DexSwapResult},
    transaction::Transaction,
};

pub const SYSTEM_FEE_RESERVE_ADDRESS: &str = "__tpow_fee_reserve__";
const MAX_MEMPOOL_TRANSACTIONS: usize = 10_000;

pub type SharedState = Arc<RwLock<NodeState>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountState {
    pub address: String,
    pub ants_balance: u64,
    pub activated_ants: u64,
    pub total_activated_ants: u64,
    pub sessions: u64,
    pub asset_balances: HashMap<String, u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountView {
    pub address: String,
    pub ants_balance: u64,
    pub anet_balance: String,
    pub sessions: u64,
    pub is_validator: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct NetworkSummary {
    pub chain_id: String,
    pub epoch_seconds: u64,
    pub total_ants: u64,
    pub total_anet: String,
    pub used_supply_history_fallback: bool,
    pub active_miners: usize,
    pub used_validator_history_fallback: bool,
    pub latest_block_height: Option<u64>,
    pub current_epoch_start: DateTime<Utc>,
    pub current_epoch_end: DateTime<Utc>,
    pub seconds_until_epoch_end: i64,
    pub mempool_depth: u64,
    pub pending_activated_supply_ants: u64,
    pub has_pending_block_work: bool,
    pub last_web2_sync_at: Option<DateTime<Utc>>,
    pub last_web2_sync_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActivationSyncResult {
    pub accounts_updated: usize,
    pub credited_ants: u64,
}

#[derive(Debug)]
pub struct NodeState {
    pub chain_id: String,
    pub genesis_time: DateTime<Utc>,
    pub accounts: HashMap<String, AccountState>,
    pub eligible_miners: Vec<String>,
    pub mempool: Vec<Transaction>,
    pub blocks: Vec<Block>,
    pub chain_db: Arc<tokio_postgres::Client>,
    pub pending_activated_supply_ants: u64,
    pub dex_pools: HashMap<String, DexPool>,
    pub genesis_path: PathBuf,
    pub epoch_seconds: u64,
    pub last_web2_sync_at: Option<DateTime<Utc>>,
    pub last_web2_sync_error: Option<String>,
}

impl NodeState {
    pub async fn from_genesis(
        genesis: GenesisConfig,
        genesis_path: PathBuf,
        _chain_path: PathBuf,
        epoch_seconds: u64,
    ) -> Result<Self> {
        let mut accounts = HashMap::new();
        for account in genesis.accounts {
            let total_activated_ants = account.total_activated_ants.max(account.ants_balance);
            accounts.insert(
                account.address.clone(),
                AccountState {
                    address: account.address,
                    ants_balance: account.ants_balance,
                    activated_ants: account.ants_balance,
                    total_activated_ants,
                    sessions: account.sessions,
                    asset_balances: HashMap::new(),
                },
            );
        }

        let chain_db = db::connect().await?;
        db::ensure_chain_initialized(chain_db.as_ref(), &genesis.chain_id, genesis.genesis_time)
            .await?;
        let blocks = db::load_chain_blocks(chain_db.as_ref()).await?;
        validate_block_sequence(&blocks)?;
        let mut eligible_miners = accounts
            .values()
            .filter(|account| account.sessions >= crate::activation::MIN_SESSIONS_FOR_ANET)
            .map(|account| account.address.clone())
            .collect::<Vec<_>>();
        eligible_miners.sort();
        eligible_miners.dedup();

        replay_blocks(&mut accounts, &blocks)?;

        Ok(Self {
            chain_id: genesis.chain_id,
            genesis_time: genesis.genesis_time,
            accounts,
            eligible_miners,
            mempool: Vec::new(),
            blocks,
            chain_db,
            pending_activated_supply_ants: 0,
            dex_pools: HashMap::new(),
            genesis_path,
            epoch_seconds,
            last_web2_sync_at: None,
            last_web2_sync_error: None,
        })
    }

    pub fn mark_web2_sync_success(&mut self) {
        self.last_web2_sync_at = Some(Utc::now());
        self.last_web2_sync_error = None;
    }

    pub fn mark_web2_sync_failure(&mut self, error: impl Into<String>) {
        self.last_web2_sync_error = Some(error.into());
    }

    pub fn replace_validators(&mut self, validators: Vec<String>) {
        let mut validators = validators;
        validators.sort();
        validators.dedup();
        self.eligible_miners = validators;
        for validator in &self.eligible_miners {
            self.accounts
                .entry(validator.clone())
                .or_insert(AccountState {
                    address: validator.clone(),
                    ants_balance: 0,
                    activated_ants: 0,
                    total_activated_ants: 0,
                    sessions: 0,
                    asset_balances: HashMap::new(),
                });
        }
    }

    pub fn sync_activated_accounts(
        &mut self,
        activated_accounts: Vec<crate::activation::GenesisAccount>,
    ) -> Result<ActivationSyncResult> {
        let mut accounts_updated = 0_usize;
        let mut credited_ants = 0_u64;
        let mut removed_ants = 0_u64;
        let mut metadata_changed = false;

        let mut active_addresses = std::collections::HashSet::new();

        for activated in activated_accounts {
            active_addresses.insert(activated.address.clone());
            let entry = self
                .accounts
                .entry(activated.address.clone())
                .or_insert(AccountState {
                    address: activated.address.clone(),
                    ants_balance: 0,
                    activated_ants: 0,
                    total_activated_ants: 0,
                    sessions: 0,
                    asset_balances: HashMap::new(),
                });

            if activated.sessions > entry.sessions {
                entry.sessions = activated.sessions;
                metadata_changed = true;
            }

            if activated.ants_balance > entry.total_activated_ants {
                let delta = activated
                    .ants_balance
                    .checked_sub(entry.total_activated_ants)
                    .ok_or_else(|| anyhow!("activation delta underflowed"))?;
                entry.ants_balance = entry
                    .ants_balance
                    .checked_add(delta)
                    .ok_or_else(|| anyhow!("account activation overflowed"))?;
                entry.activated_ants = entry
                    .activated_ants
                    .checked_add(delta)
                    .ok_or_else(|| anyhow!("account activation remainder overflowed"))?;
                entry.total_activated_ants = activated.ants_balance;
                credited_ants = credited_ants
                    .checked_add(delta)
                    .ok_or_else(|| anyhow!("credited activation total overflowed"))?;
                self.pending_activated_supply_ants = self
                    .pending_activated_supply_ants
                    .checked_add(delta)
                    .ok_or_else(|| anyhow!("pending activation total overflowed"))?;
                accounts_updated += 1;
                metadata_changed = true;
            }
        }

        for entry in self.accounts.values_mut() {
            if entry.sessions < crate::activation::MIN_SESSIONS_FOR_ANET
                && entry.activated_ants > 0
                && !active_addresses.contains(&entry.address)
            {
                entry.ants_balance = entry
                    .ants_balance
                    .checked_sub(entry.activated_ants)
                    .ok_or_else(|| anyhow!("retroactive activation clawback underflowed"))?;
                removed_ants = removed_ants
                    .checked_add(entry.activated_ants)
                    .ok_or_else(|| anyhow!("removed activation total overflowed"))?;
                entry.activated_ants = 0;
                entry.total_activated_ants = 0;
                metadata_changed = true;
            }
        }

        if metadata_changed {
            self.persist_genesis_snapshot()?;
        }

        if removed_ants > 0 {
            tracing::info!(
                accounts_updated = accounts_updated,
                credited_ants = credited_ants,
                removed_ants = removed_ants,
                min_sessions = crate::activation::MIN_SESSIONS_FOR_ANET,
                "removed legacy Web2-derived ANET from under-threshold wallets"
            );
        }

        Ok(ActivationSyncResult {
            accounts_updated,
            credited_ants,
        })
    }

    pub fn all_blocks(&self) -> Vec<Block> {
        self.blocks.clone()
    }

    pub fn latest_blocks(&self, limit: usize) -> Vec<Block> {
        self.blocks.iter().rev().take(limit).cloned().collect()
    }

    pub fn block_by_id(&self, id: &str) -> Option<Block> {
        if let Ok(height) = id.parse::<u64>() {
            return self
                .blocks
                .iter()
                .find(|block| block.block_height == height)
                .cloned();
        }

        self.blocks.iter().find(|block| block.hash == id).cloned()
    }

    pub fn account_view(&self, address: &str) -> Option<AccountView> {
        self.accounts.get(address).map(|account| AccountView {
            address: account.address.clone(),
            ants_balance: account.ants_balance,
            anet_balance: format_anet_fixed(account.ants_balance),
            sessions: account.sessions,
            is_validator: self.eligible_miners.iter().any(|miner| miner == address),
        })
    }

    pub fn network_summary(&self) -> NetworkSummary {
        let now = Utc::now();
        let (current_epoch_start, current_epoch_end) =
            crate::consensus::current_epoch_window(now, self.epoch_seconds);
        let accounts_total_ants: u64 = self
            .accounts
            .values()
            .map(|account| account.ants_balance)
            .sum();
        let chain_activated_ants: u64 = self
            .blocks
            .iter()
            .map(|block| block.activated_supply_ants)
            .sum();
        // If runtime account state is empty after restart/sync drift, preserve a stable
        // supply display from finalized block history instead of showing a false zero.
        let total_ants = if accounts_total_ants == 0 && chain_activated_ants > 0 {
            chain_activated_ants
        } else {
            accounts_total_ants
        };
        let used_supply_history_fallback = accounts_total_ants == 0 && chain_activated_ants > 0;
        let active_miners = if self.eligible_miners.is_empty() {
            self.blocks
                .last()
                .map(|block| block.miners.len())
                .unwrap_or(0)
        } else {
            self.eligible_miners.len()
        };
        let used_validator_history_fallback = self.eligible_miners.is_empty()
            && self
                .blocks
                .last()
                .map(|block| !block.miners.is_empty())
                .unwrap_or(false);
        let has_pending_block_work = self.has_pending_block_work();

        NetworkSummary {
            chain_id: self.chain_id.clone(),
            epoch_seconds: self.epoch_seconds,
            total_ants,
            total_anet: format_anet_fixed(total_ants),
            used_supply_history_fallback,
            active_miners,
            used_validator_history_fallback,
            latest_block_height: self.blocks.last().map(|block| block.block_height),
            current_epoch_start,
            current_epoch_end,
            seconds_until_epoch_end: (current_epoch_end - now).num_seconds().max(0),
            mempool_depth: self.mempool.len() as u64,
            pending_activated_supply_ants: self.pending_activated_supply_ants,
            has_pending_block_work,
            last_web2_sync_at: self.last_web2_sync_at,
            last_web2_sync_error: self.last_web2_sync_error.clone(),
        }
    }

    pub fn queue_transaction(&mut self, transaction: Transaction) -> Result<String> {
        transaction.validate()?;

        if self.mempool.len() >= MAX_MEMPOOL_TRANSACTIONS {
            return Err(anyhow!("mempool is full"));
        }

        let sender = self
            .accounts
            .get(&transaction.from)
            .ok_or_else(|| anyhow!("sender account not found in state"))?;

        if !Self::allow_ineligible_wallet_test_mode()
            && sender.sessions < crate::activation::MIN_SESSIONS_FOR_ANET
        {
            return Err(anyhow!(
                "sender must complete at least {} Web2 sessions before spending mined ANTS/ANET or sending P2P",
                crate::activation::MIN_SESSIONS_FOR_ANET
            ));
        }

        let recipient = self.accounts.get(&transaction.to).ok_or_else(|| {
            anyhow!("recipient must complete at least 1000 Web2 sessions before receiving ANET")
        })?;

        if !Self::allow_ineligible_wallet_test_mode()
            && recipient.sessions < crate::activation::MIN_SESSIONS_FOR_ANET
        {
            return Err(anyhow!(
                "recipient must complete at least {} Web2 sessions before participating in P2P ANET transfers",
                crate::activation::MIN_SESSIONS_FOR_ANET
            ));
        }

        let transaction_id = transaction.id()?;
        if self
            .mempool
            .iter()
            .any(|queued| queued.id().map(|id| id == transaction_id).unwrap_or(false))
        {
            return Err(anyhow!("duplicate transaction already queued"));
        }

        let pending_outgoing = self
            .mempool
            .iter()
            .filter(|tx| tx.from == transaction.from)
            .try_fold(0_u64, |sum, tx| {
                sum.checked_add(tx.total_debit()?)
                    .ok_or_else(|| anyhow!("pending debit overflowed"))
            })?;

        let required = transaction.total_debit()?;
        let available = sender
            .ants_balance
            .checked_sub(pending_outgoing)
            .ok_or_else(|| anyhow!("sender has no spendable balance left"))?;

        if available < required {
            return Err(anyhow!("insufficient ANTS balance for transaction and fee"));
        }

        self.mempool.push(transaction);
        Ok(transaction_id)
    }

    pub fn has_pending_block_work(&self) -> bool {
        !self.mempool.is_empty() || self.pending_activated_supply_ants > 0
    }

    pub fn dex_pool_list(&self) -> Vec<DexPoolView> {
        let mut pools = self
            .dex_pools
            .values()
            .map(DexPool::view)
            .collect::<Vec<_>>();
        pools.sort_by(|left, right| left.pair_id.cmp(&right.pair_id));
        pools
    }

    pub fn dex_pool_view(&self, token_symbol: &str) -> Result<Option<DexPoolView>> {
        let key = dex::pool_key(token_symbol)?;
        Ok(self.dex_pools.get(&key).map(DexPool::view))
    }

    pub fn dex_mint_test_asset(
        &mut self,
        address: &str,
        token_symbol: &str,
        amount: u64,
    ) -> Result<u64> {
        if amount == 0 {
            return Err(anyhow!("mint amount must be greater than zero"));
        }

        let symbol = dex::normalize_token_symbol(token_symbol)?;
        let account = self
            .accounts
            .get_mut(&address.trim().to_uppercase())
            .ok_or_else(|| anyhow!("account not found"))?;

        let new_balance = account
            .asset_balances
            .get(&symbol)
            .copied()
            .unwrap_or(0)
            .checked_add(amount)
            .ok_or_else(|| anyhow!("asset balance overflowed"))?;
        account.asset_balances.insert(symbol, new_balance);
        Ok(new_balance)
    }

    pub fn admin_credit_anet_test(&mut self, address: &str, amount_ants: u64) -> Result<u64> {
        if amount_ants == 0 {
            return Err(anyhow!("mint amount must be greater than zero"));
        }

        let account = self
            .accounts
            .get_mut(&address.trim().to_uppercase())
            .ok_or_else(|| anyhow!("account not found"))?;

        let new_balance = account
            .ants_balance
            .checked_add(amount_ants)
            .ok_or_else(|| anyhow!("ANET balance overflowed"))?;
        account.ants_balance = new_balance;
        Ok(new_balance)
    }

    pub fn dex_create_pool(
        &mut self,
        provider: &str,
        token_symbol: &str,
        anet_amount_ants: u64,
        token_amount_units: u64,
        fee_bps: Option<u16>,
    ) -> Result<DexLiquidityResult> {
        let provider = provider.trim().to_uppercase();
        let symbol = dex::normalize_token_symbol(token_symbol)?;
        let pair_id = dex::pool_key(&symbol)?;

        if self.dex_pools.contains_key(&pair_id) {
            return Err(anyhow!("pool already exists"));
        }
        if anet_amount_ants == 0 || token_amount_units == 0 {
            return Err(anyhow!("initial liquidity must be greater than zero"));
        }

        let account = self.ensure_eligible_account_mut(&provider)?;
        debit_anet(account, anet_amount_ants)?;
        debit_asset(account, &symbol, token_amount_units)?;

        let fee_bps = dex::validate_fee_bps(fee_bps.unwrap_or(dex::DEFAULT_FEE_BPS))?;
        let total_lp_units =
            dex::initial_lp_units(u128::from(anet_amount_ants), u128::from(token_amount_units))?;

        let mut lp_positions = HashMap::new();
        lp_positions.insert(provider.clone(), total_lp_units);

        let pool = DexPool {
            pair_id: pair_id.clone(),
            token_symbol: symbol,
            anet_reserve_ants: u128::from(anet_amount_ants),
            token_reserve_units: u128::from(token_amount_units),
            total_lp_units,
            fee_bps,
            lp_positions,
            updated_at: Utc::now(),
        };

        self.dex_pools.insert(pair_id.clone(), pool);

        Ok(DexLiquidityResult {
            pair_id,
            provider,
            lp_minted: total_lp_units.to_string(),
            total_lp_units: total_lp_units.to_string(),
        })
    }

    pub fn dex_add_liquidity(
        &mut self,
        provider: &str,
        token_symbol: &str,
        anet_amount_ants: u64,
        token_amount_units: u64,
    ) -> Result<DexLiquidityResult> {
        let provider = provider.trim().to_uppercase();
        let pair_id = dex::pool_key(token_symbol)?;
        if anet_amount_ants == 0 || token_amount_units == 0 {
            return Err(anyhow!("liquidity amounts must be greater than zero"));
        }

        let (pool_token_symbol, pool_anet_reserve, pool_token_reserve, pool_total_lp) = {
            let pool = self
                .dex_pools
                .get(&pair_id)
                .ok_or_else(|| anyhow!("pool not found"))?;
            (
                pool.token_symbol.clone(),
                pool.anet_reserve_ants,
                pool.token_reserve_units,
                pool.total_lp_units,
            )
        };

        let required_token = u128::from(anet_amount_ants)
            .checked_mul(pool_token_reserve)
            .ok_or_else(|| anyhow!("required token overflowed"))?
            / pool_anet_reserve;
        let provided_token = u128::from(token_amount_units);
        let drift = required_token.abs_diff(provided_token);
        if drift > 1 {
            return Err(anyhow!(
                "liquidity ratio mismatch: expected roughly {required_token} {}, got {provided_token}",
                pool_token_symbol
            ));
        }

        let minted_lp = u128::from(anet_amount_ants)
            .checked_mul(pool_total_lp)
            .ok_or_else(|| anyhow!("LP mint overflowed"))?
            / pool_anet_reserve;
        if minted_lp == 0 {
            return Err(anyhow!("liquidity contribution is too small"));
        }

        {
            let account = self.ensure_eligible_account_mut(&provider)?;
            debit_anet(account, anet_amount_ants)?;
            debit_asset(account, &pool_token_symbol, token_amount_units)?;
        }

        let pool = self
            .dex_pools
            .get_mut(&pair_id)
            .ok_or_else(|| anyhow!("pool not found"))?;

        pool.anet_reserve_ants = pool
            .anet_reserve_ants
            .checked_add(u128::from(anet_amount_ants))
            .ok_or_else(|| anyhow!("pool ANET reserve overflowed"))?;
        pool.token_reserve_units = pool
            .token_reserve_units
            .checked_add(u128::from(token_amount_units))
            .ok_or_else(|| anyhow!("pool token reserve overflowed"))?;
        pool.total_lp_units = pool
            .total_lp_units
            .checked_add(minted_lp)
            .ok_or_else(|| anyhow!("pool LP overflowed"))?;
        *pool.lp_positions.entry(provider.clone()).or_insert(0) += minted_lp;
        pool.updated_at = Utc::now();

        Ok(DexLiquidityResult {
            pair_id,
            provider,
            lp_minted: minted_lp.to_string(),
            total_lp_units: pool.total_lp_units.to_string(),
        })
    }

    pub fn dex_quote(
        &self,
        token_symbol: &str,
        amount_in: u64,
        anet_to_token: bool,
    ) -> Result<DexQuoteView> {
        let pair_id = dex::pool_key(token_symbol)?;
        let pool = self
            .dex_pools
            .get(&pair_id)
            .ok_or_else(|| anyhow!("pool not found"))?;

        let (reserve_in, reserve_out, direction) = if anet_to_token {
            (
                pool.anet_reserve_ants,
                pool.token_reserve_units,
                format!("ANET->{}", pool.token_symbol),
            )
        } else {
            (
                pool.token_reserve_units,
                pool.anet_reserve_ants,
                format!("{}->ANET", pool.token_symbol),
            )
        };

        let (amount_out, fee_paid, price_impact_bps) =
            dex::quote_amount_out(reserve_in, reserve_out, u128::from(amount_in), pool.fee_bps)?;
        let min_out_1pct_slippage = amount_out
            .checked_mul(99)
            .ok_or_else(|| anyhow!("slippage math overflowed"))?
            / 100;

        Ok(DexQuoteView {
            pair_id,
            direction,
            amount_in: amount_in.to_string(),
            amount_out: amount_out.to_string(),
            fee_paid: fee_paid.to_string(),
            min_out_1pct_slippage: min_out_1pct_slippage.to_string(),
            price_impact_bps,
        })
    }

    pub fn dex_swap(
        &mut self,
        trader: &str,
        token_symbol: &str,
        amount_in: u64,
        anet_to_token: bool,
    ) -> Result<DexSwapResult> {
        let trader = trader.trim().to_uppercase();
        let pair_id = dex::pool_key(token_symbol)?;
        if amount_in == 0 {
            return Err(anyhow!("swap amount must be greater than zero"));
        }

        let (pool_token_symbol, pool_fee_bps, reserve_in, reserve_out, direction) = {
            let pool = self
                .dex_pools
                .get(&pair_id)
                .ok_or_else(|| anyhow!("pool not found"))?;
            let (reserve_in, reserve_out, direction) = if anet_to_token {
                (
                    pool.anet_reserve_ants,
                    pool.token_reserve_units,
                    format!("ANET->{}", pool.token_symbol),
                )
            } else {
                (
                    pool.token_reserve_units,
                    pool.anet_reserve_ants,
                    format!("{}->ANET", pool.token_symbol),
                )
            };
            (
                pool.token_symbol.clone(),
                pool.fee_bps,
                reserve_in,
                reserve_out,
                direction,
            )
        };

        let (amount_out, fee_paid, _) =
            dex::quote_amount_out(reserve_in, reserve_out, u128::from(amount_in), pool_fee_bps)?;

        {
            let account = self.ensure_eligible_account_mut(&trader)?;
            if anet_to_token {
                debit_anet(account, amount_in)?;
                credit_asset(
                    account,
                    &pool_token_symbol,
                    u64::try_from(amount_out).map_err(|_| anyhow!("swap output overflowed"))?,
                )?;
            } else {
                debit_asset(account, &pool_token_symbol, amount_in)?;
                credit_anet(
                    account,
                    u64::try_from(amount_out).map_err(|_| anyhow!("swap output overflowed"))?,
                )?;
            }
        }

        let pool = self
            .dex_pools
            .get_mut(&pair_id)
            .ok_or_else(|| anyhow!("pool not found"))?;

        if anet_to_token {
            pool.anet_reserve_ants = pool
                .anet_reserve_ants
                .checked_add(u128::from(amount_in))
                .ok_or_else(|| anyhow!("pool reserve overflowed"))?;
            pool.token_reserve_units = pool
                .token_reserve_units
                .checked_sub(amount_out)
                .ok_or_else(|| anyhow!("pool token reserve underflowed"))?;
        } else {
            pool.token_reserve_units = pool
                .token_reserve_units
                .checked_add(u128::from(amount_in))
                .ok_or_else(|| anyhow!("pool reserve overflowed"))?;
            pool.anet_reserve_ants = pool
                .anet_reserve_ants
                .checked_sub(amount_out)
                .ok_or_else(|| anyhow!("pool ANET reserve underflowed"))?;
        }

        pool.updated_at = Utc::now();

        Ok(DexSwapResult {
            pair_id,
            trader,
            direction,
            amount_in: amount_in.to_string(),
            amount_out: amount_out.to_string(),
            fee_paid: fee_paid.to_string(),
        })
    }

    fn ensure_eligible_account_mut(&mut self, address: &str) -> Result<&mut AccountState> {
        let account = self
            .accounts
            .get_mut(address)
            .ok_or_else(|| anyhow!("account not found"))?;
        if !Self::allow_ineligible_wallet_test_mode()
            && account.sessions < crate::activation::MIN_SESSIONS_FOR_ANET
        {
            return Err(anyhow!(
                "wallet must complete at least {} sessions before spending mined ANTS/ANET on native DEX",
                crate::activation::MIN_SESSIONS_FOR_ANET
            ));
        }
        Ok(account)
    }

    fn allow_ineligible_wallet_test_mode() -> bool {
        std::env::var("ANET_ALLOW_INELIGIBLE_WALLET_TEST")
            .map(|value| {
                let normalized = value.trim().to_ascii_lowercase();
                normalized == "1"
                    || normalized == "true"
                    || normalized == "yes"
                    || normalized == "on"
            })
            .unwrap_or(false)
    }

    pub fn has_block_in_epoch(&self, epoch_start: DateTime<Utc>) -> bool {
        self.blocks
            .last()
            .map(|block| block.epoch_start == epoch_start)
            .unwrap_or(false)
    }

    pub async fn create_block(
        &mut self,
        epoch_start: DateTime<Utc>,
        epoch_end: DateTime<Utc>,
    ) -> Result<Block> {
        let block_height = self
            .blocks
            .last()
            .map(|block| block.block_height.saturating_add(1))
            .unwrap_or(0);
        let previous_hash = db::get_last_hash(self.chain_db.as_ref())
            .await?
            .unwrap_or_else(|| "GENESIS".to_owned());
        let miners = self.eligible_miners.clone();
        let transactions = std::mem::take(&mut self.mempool);
        let activated_supply_ants = std::mem::take(&mut self.pending_activated_supply_ants);

        let block = Block::new(
            block_height,
            epoch_start,
            epoch_end,
            previous_hash,
            transactions,
            activated_supply_ants,
            miners,
        )?;

        apply_block(&mut self.accounts, &block)?;

        if !block.validate_hash()? {
            return Err(anyhow!("generated block hash failed validation"));
        }

        db::store_block_and_update_tip(self.chain_db.as_ref(), &block).await?;
        self.blocks.push(block.clone());

        tracing::info!(
            block_height = block.block_height,
            hash = %block.hash,
            tx_count = block.transactions.len(),
            activated_supply_ants = block.activated_supply_ants,
            miners = block.miners.len(),
            total_fees_ants = block.total_fees_ants,
            "created TPoW block"
        );

        Ok(block)
    }

    fn persist_genesis_snapshot(&self) -> Result<()> {
        let mut accounts = self
            .accounts
            .values()
            .filter(|account| account.activated_ants > 0 || account.sessions > 0)
            .map(|account| crate::activation::GenesisAccount {
                address: account.address.clone(),
                ants_balance: account.activated_ants,
                sessions: account.sessions,
                total_activated_ants: account.total_activated_ants,
            })
            .collect::<Vec<_>>();
        accounts.sort_by(|left, right| left.address.cmp(&right.address));

        crate::activation::write_genesis(
            &self.genesis_path,
            &crate::activation::GenesisConfig {
                chain_id: self.chain_id.clone(),
                genesis_time: self.genesis_time,
                accounts,
            },
        )
    }
}

pub async fn bootstrap_chain_store(
    genesis: &GenesisConfig,
    _chain_path: &std::path::Path,
) -> Result<()> {
    let chain_db = db::connect().await?;
    db::ensure_chain_initialized(chain_db.as_ref(), &genesis.chain_id, genesis.genesis_time).await
}

fn replay_blocks(accounts: &mut HashMap<String, AccountState>, blocks: &[Block]) -> Result<()> {
    reconcile_replay_sender_balances(accounts, blocks)?;

    for block in blocks {
        apply_block(accounts, block)?;
    }

    Ok(())
}

fn reconcile_replay_sender_balances(
    accounts: &mut HashMap<String, AccountState>,
    blocks: &[Block],
) -> Result<()> {
    let mut simulation_accounts = accounts.clone();
    let mut sender_topups: HashMap<String, u64> = HashMap::new();

    for block in blocks {
        for transaction in &block.transactions {
            let sender = simulation_accounts
                .entry(transaction.from.clone())
                .or_insert_with(|| empty_account_state(transaction.from.clone()));
            let debit = transaction.total_debit()?;

            if sender.ants_balance < debit {
                let deficit = debit - sender.ants_balance;
                let topup = sender_topups.entry(transaction.from.clone()).or_insert(0);
                *topup = topup
                    .checked_add(deficit)
                    .ok_or_else(|| anyhow!("replay sender topup overflowed"))?;
                sender.ants_balance = sender
                    .ants_balance
                    .checked_add(deficit)
                    .ok_or_else(|| anyhow!("replay sender balance overflowed"))?;
                sender.activated_ants = sender.activated_ants.saturating_add(deficit);
                sender.total_activated_ants = sender.total_activated_ants.saturating_add(deficit);
            }

            sender.ants_balance = sender
                .ants_balance
                .checked_sub(debit)
                .ok_or_else(|| anyhow!("sender balance underflow while reconciling replay"))?;
            sender.activated_ants = sender.activated_ants.saturating_sub(debit);

            let recipient = simulation_accounts
                .entry(transaction.to.clone())
                .or_insert_with(|| empty_account_state(transaction.to.clone()));
            recipient.ants_balance = recipient
                .ants_balance
                .checked_add(transaction.amount_ants)
                .ok_or_else(|| anyhow!("recipient balance overflow while reconciling replay"))?;
        }

        distribute_fees(&mut simulation_accounts, block)?;
    }

    for (address, amount) in sender_topups {
        let account = accounts
            .entry(address.clone())
            .or_insert_with(|| empty_account_state(address.clone()));
        account.ants_balance = account
            .ants_balance
            .checked_add(amount)
            .ok_or_else(|| anyhow!("sender replay topup overflowed"))?;
        account.activated_ants = account.activated_ants.saturating_add(amount);
        account.total_activated_ants = account.total_activated_ants.saturating_add(amount);

        tracing::warn!(
            wallet = %address,
            amount_ants = amount,
            "replay reconciliation credited sender balance to satisfy historical block debits"
        );
    }

    Ok(())
}

fn empty_account_state(address: String) -> AccountState {
    AccountState {
        address,
        ants_balance: 0,
        activated_ants: 0,
        total_activated_ants: 0,
        sessions: 0,
        asset_balances: HashMap::new(),
    }
}

fn validate_block_sequence(blocks: &[Block]) -> Result<()> {
    let mut previous_hash = "GENESIS".to_owned();
    let mut previous_epoch_end = None;

    for (index, block) in blocks.iter().enumerate() {
        block.validate_structure()?;
        if !block.validate_hash()? {
            return Err(anyhow!(
                "stored block {} failed hash validation",
                block.block_height
            ));
        }
        if block.block_height != index as u64 {
            return Err(anyhow!(
                "stored block height {} is out of sequence at position {}",
                block.block_height,
                index
            ));
        }
        if block.previous_hash != previous_hash {
            return Err(anyhow!(
                "stored block {} has invalid previous hash linkage",
                block.block_height
            ));
        }
        if let Some(previous_epoch_end) = previous_epoch_end {
            if block.epoch_start < previous_epoch_end {
                return Err(anyhow!(
                    "stored block {} overlaps an earlier epoch",
                    block.block_height
                ));
            }
        }

        previous_hash = block.hash.clone();
        previous_epoch_end = Some(block.epoch_end);
    }

    Ok(())
}

fn apply_block(accounts: &mut HashMap<String, AccountState>, block: &Block) -> Result<()> {
    for transaction in &block.transactions {
        let sender = accounts
            .get_mut(&transaction.from)
            .ok_or_else(|| anyhow!("sender account not found while applying block"))?;
        let debit = transaction.total_debit()?;
        sender.ants_balance = sender
            .ants_balance
            .checked_sub(debit)
            .ok_or_else(|| anyhow!("sender balance underflow while applying block"))?;
        sender.activated_ants = sender.activated_ants.saturating_sub(debit);

        let recipient = accounts
            .entry(transaction.to.clone())
            .or_insert(AccountState {
                address: transaction.to.clone(),
                ants_balance: 0,
                activated_ants: 0,
                total_activated_ants: 0,
                sessions: 0,
                asset_balances: HashMap::new(),
            });
        recipient.ants_balance = recipient
            .ants_balance
            .checked_add(transaction.amount_ants)
            .ok_or_else(|| anyhow!("recipient balance overflow while applying block"))?;
    }

    distribute_fees(accounts, block)
}

fn distribute_fees(accounts: &mut HashMap<String, AccountState>, block: &Block) -> Result<()> {
    if block.total_fees_ants == 0 {
        return Ok(());
    }

    if block.miners.is_empty() {
        let reserve = accounts
            .entry(SYSTEM_FEE_RESERVE_ADDRESS.to_owned())
            .or_insert(AccountState {
                address: SYSTEM_FEE_RESERVE_ADDRESS.to_owned(),
                ants_balance: 0,
                activated_ants: 0,
                total_activated_ants: 0,
                sessions: 0,
                asset_balances: HashMap::new(),
            });
        reserve.ants_balance = reserve
            .ants_balance
            .checked_add(block.total_fees_ants)
            .ok_or_else(|| anyhow!("fee reserve overflowed"))?;
        return Ok(());
    }

    let remainder = block.total_fees_ants % block.miners.len() as u64;
    for miner in &block.miners {
        let account = accounts.entry(miner.clone()).or_insert(AccountState {
            address: miner.clone(),
            ants_balance: 0,
            activated_ants: 0,
            total_activated_ants: 0,
            sessions: 0,
            asset_balances: HashMap::new(),
        });
        account.ants_balance = account
            .ants_balance
            .checked_add(block.fee_per_miner)
            .ok_or_else(|| anyhow!("miner fee distribution overflowed"))?;
    }

    if remainder > 0 {
        let reserve = accounts
            .entry(SYSTEM_FEE_RESERVE_ADDRESS.to_owned())
            .or_insert(AccountState {
                address: SYSTEM_FEE_RESERVE_ADDRESS.to_owned(),
                ants_balance: 0,
                activated_ants: 0,
                total_activated_ants: 0,
                sessions: 0,
                asset_balances: HashMap::new(),
            });
        reserve.ants_balance = reserve
            .ants_balance
            .checked_add(remainder)
            .ok_or_else(|| anyhow!("fee reserve overflowed"))?;
    }

    Ok(())
}

pub fn format_anet_fixed(ants: u64) -> String {
    let whole = ants / ANTS_PER_ANET;
    let fractional = ants % ANTS_PER_ANET;
    format!("{whole}.{fractional:08}")
}

fn debit_anet(account: &mut AccountState, amount: u64) -> Result<()> {
    account.ants_balance = account
        .ants_balance
        .checked_sub(amount)
        .ok_or_else(|| anyhow!("insufficient ANET balance"))?;
    account.activated_ants = account.activated_ants.saturating_sub(amount);
    Ok(())
}

fn credit_anet(account: &mut AccountState, amount: u64) -> Result<()> {
    account.ants_balance = account
        .ants_balance
        .checked_add(amount)
        .ok_or_else(|| anyhow!("ANET balance overflowed"))?;
    Ok(())
}

fn debit_asset(account: &mut AccountState, symbol: &str, amount: u64) -> Result<()> {
    let balance = account.asset_balances.get(symbol).copied().unwrap_or(0);
    if balance < amount {
        return Err(anyhow!("insufficient {symbol} balance"));
    }
    let next = balance
        .checked_sub(amount)
        .ok_or_else(|| anyhow!("asset balance underflowed"))?;
    account.asset_balances.insert(symbol.to_owned(), next);
    Ok(())
}

fn credit_asset(account: &mut AccountState, symbol: &str, amount: u64) -> Result<()> {
    let balance = account.asset_balances.get(symbol).copied().unwrap_or(0);
    let next = balance
        .checked_add(amount)
        .ok_or_else(|| anyhow!("asset balance overflowed"))?;
    account.asset_balances.insert(symbol.to_owned(), next);
    Ok(())
}
